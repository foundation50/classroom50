import type { GitHubClient } from "../client"
import { GitHubAPIError, is422UnexpectedInputs } from "../errors"
import { getRepo } from "../repoReads"
import {
  COLLECT_SCORES_WORKFLOW,
  PROBE_TOKEN_WORKFLOW,
  REGRADE_WORKFLOW,
} from "../workflows"
import { CONFIG_REPO, DEFAULT_BRANCH } from "@/util/configRepo"
import { logger } from "@/lib/logger"

const logWorkflows = logger.scope("github:workflows")

// The org's classroom50 repo has no probe-token.yaml (its skeleton predates the
// workflow), so GitHub 404'd the workflow. The view maps this to "update the
// workflow files first" rather than a generic dispatch failure.
export class ProbeWorkflowMissingError extends Error {
  constructor(cause: unknown) {
    super(
      "probe-token.yaml is not in the config repo; the org's workflow files are out of date",
    )
    this.name = "ProbeWorkflowMissingError"
    this.cause = cause
  }
}

// The org's collect-scores.yaml predates the `assignment` dispatch input, so
// GitHub rejected the scoped dispatch with a 422 ("Unexpected inputs"). The
// message is developer-facing (logs); the view layer maps this class to a
// translated "update your classroom50 repository" explanation.
export class CollectInputsUnsupportedError extends Error {
  constructor(cause: unknown) {
    super(
      "collect-scores.yaml does not declare the `assignment` input; the config repo's workflows are out of date",
    )
    this.name = "CollectInputsUnsupportedError"
    this.cause = cause
  }
}

/**
 * Dispatches the classroom50 repo's `collect-scores.yaml` workflow (the same
 * job that refreshes `scores.json`) so a teacher can pull fresh
 * submissions on demand.
 *
 * Returns `sinceRunId`: the newest collect-scores dispatch run before this POST
 * (null if none). The dispatch API returns no run id, so the caller finds the
 * triggered run as the oldest dispatch run with a larger id — monotonic, so no
 * clock comparison and unambiguous when dispatches race.
 *
 * @param scope optional dispatch inputs narrowing the collection to one
 *   classroom, or one assignment within it; omitted collects org-wide.
 *   Sending `assignment` against a config repo whose workflow predates the
 *   input throws CollectInputsUnsupportedError.
 * @param names optional display names for the scope, sent as the label-only
 *   `classroom_name` / `assignment_name` inputs so the run's title on GitHub
 *   reads the classroom and assignment by name rather than slug. Dropped and
 *   retried without if the org's workflow predates those inputs.
 */
export async function triggerScoreCollection(
  client: GitHubClient,
  org: string | undefined,
  scope?: { classroom: string; assignment?: string },
  names?: { classroom?: string; assignment?: string },
): Promise<{ sinceRunId: number | null }> {
  if (!org) throw new Error("org must be specified to collect scores")

  const repo = await getRepo(client, org, CONFIG_REPO)
  if (!repo) {
    throw new Error(
      `${org}/${CONFIG_REPO} not found; run setup for this org first`,
    )
  }
  const ref = repo.default_branch || DEFAULT_BRANCH

  // Snapshot the newest dispatch run id before the POST. Run ids are monotonic,
  // so the run this POST creates is the oldest dispatch run whose id exceeds it.
  const baseline = await client.request<{ workflow_runs: { id: number }[] }>(
    `/repos/${org}/${CONFIG_REPO}/actions/workflows/${COLLECT_SCORES_WORKFLOW}/runs?event=workflow_dispatch&per_page=1`,
  )
  const sinceRunId = baseline.workflow_runs?.[0]?.id ?? null

  const inputs: Record<string, string> = {}
  if (scope) {
    inputs.classroom = scope.classroom
    if (scope.assignment) inputs.assignment = scope.assignment
  }
  // Label-only inputs. A name equal to its slug adds nothing, so skip it and
  // keep the payload minimal for the common unnamed case.
  const labelInputs: Record<string, string> = {}
  if (scope && names?.classroom && names.classroom !== scope.classroom) {
    labelInputs.classroom_name = names.classroom
  }
  if (
    scope?.assignment &&
    names?.assignment &&
    names.assignment !== scope.assignment
  ) {
    labelInputs.assignment_name = names.assignment
  }

  const dispatch = (body: Record<string, string>) =>
    client.request(
      `/repos/${org}/${CONFIG_REPO}/actions/workflows/${COLLECT_SCORES_WORKFLOW}/dispatches`,
      { method: "POST", body: { ref, inputs: body } },
    )

  try {
    try {
      await dispatch({ ...inputs, ...labelInputs })
    } catch (err) {
      // GitHub 422s on ANY undeclared input key, so an org whose workflow
      // predates the *_name inputs would otherwise lose collect entirely over
      // a cosmetic label. Retry once with the slugs only: the run still
      // happens, just titled by slug until the org updates its workflows.
      if (Object.keys(labelInputs).length === 0 || !is422UnexpectedInputs(err))
        throw err
      logWorkflows.info(
        "collect-scores.yaml predates the *_name inputs; retrying without",
        { org },
      )
      await dispatch(inputs)
    }
  } catch (err) {
    // Only the `assignment` input is newer than the long-standing `classroom`
    // one, so a 422 "unexpected inputs" on a scoped dispatch means the config
    // repo's workflow predates per-assignment collection.
    if (scope?.assignment && is422UnexpectedInputs(err)) {
      throw new CollectInputsUnsupportedError(err)
    }
    throw err
  }

  logWorkflows.info("dispatched collect-scores", {
    org,
    classroom: scope?.classroom ?? "(all)",
    assignment: scope?.assignment ?? "(all)",
    sinceRunId,
  })
  return { sinceRunId }
}

/**
 * Dispatches the classroom50 repo's `regrade.yaml` workflow
 * to re-run the autograder for an assignment — the whole assignment, or
 * a single student when `owner` is supplied. Each targeted repo re-grades its
 * current `main` HEAD; grading runs asynchronously, so the gradebook is
 * refreshed by a subsequent collect-scores run.
 *
 * Returns `sinceRunId`: the newest regrade dispatch run before this POST (null
 * if none). The dispatch API returns no run id, so the caller binds to its own
 * run as the oldest dispatch run with a larger id (monotonic — no clock needed,
 * unambiguous when dispatches race). Mirrors triggerScoreCollection.
 *
 * @param classroom required dispatch input (the regrade workflow is always
 *   classroom-scoped, unlike collect which can sweep org-wide).
 * @param assignment required dispatch input (the assignment slug).
 * @param owner optional dispatch input — a single repo-owner login to regrade;
 *   omitted regrades every rostered student for the assignment.
 */
export async function triggerRegrade(
  client: GitHubClient,
  params: {
    org: string | undefined
    classroom: string | undefined
    assignment: string | undefined
    owner?: string
  },
): Promise<{ sinceRunId: number | null }> {
  const { org, classroom, assignment, owner } = params
  if (!org) throw new Error("org must be specified to regrade")
  if (!classroom) throw new Error("classroom must be specified to regrade")
  if (!assignment) throw new Error("assignment must be specified to regrade")

  // getRepo (for the dispatch ref) and the baseline snapshot are independent
  // reads; run them together. The baseline must still precede the POST below —
  // run ids are monotonic, so the run this POST creates is the oldest dispatch
  // run whose id exceeds the snapshot.
  const [repo, baseline] = await Promise.all([
    getRepo(client, org, CONFIG_REPO),
    client.request<{ workflow_runs: { id: number }[] }>(
      `/repos/${org}/${CONFIG_REPO}/actions/workflows/${REGRADE_WORKFLOW}/runs?event=workflow_dispatch&per_page=1`,
    ),
  ])
  if (!repo) {
    throw new Error(
      `${org}/${CONFIG_REPO} not found; run setup for this org first`,
    )
  }
  const ref = repo.default_branch || DEFAULT_BRANCH
  const sinceRunId = baseline.workflow_runs?.[0]?.id ?? null

  // The workflow's `owner` input is optional; only send it when scoping to a
  // single student so an empty string isn't passed as a (no-op) filter.
  const inputs: Record<string, string> = { classroom, assignment }
  if (owner) inputs.owner = owner

  await client.request(
    `/repos/${org}/${CONFIG_REPO}/actions/workflows/${REGRADE_WORKFLOW}/dispatches`,
    {
      method: "POST",
      body: { ref, inputs },
    },
  )

  logWorkflows.info("dispatched regrade", {
    org,
    classroom,
    assignment,
    owner: owner ?? "(all)",
    sinceRunId,
  })
  return { sinceRunId }
}

/**
 * Dispatches the classroom50 repo's `probe-token.yaml` workflow, the read-only
 * check that exercises every scope the service token needs. No inputs.
 *
 * Returns `sinceRunId` like the other dispatchers so the caller can bind to its
 * own run. A 404 on the workflow (baseline read or dispatch) means the org's
 * skeleton predates probe-token.yaml and surfaces as ProbeWorkflowMissingError.
 */
export async function triggerProbeToken(
  client: GitHubClient,
  org: string | undefined,
): Promise<{ sinceRunId: number | null }> {
  if (!org) throw new Error("org must be specified to probe the service token")

  const workflowBase = `/repos/${org}/${CONFIG_REPO}/actions/workflows/${PROBE_TOKEN_WORKFLOW}`
  const rethrowMissingWorkflow = (err: unknown): never => {
    if (err instanceof GitHubAPIError && err.isNotFound) {
      throw new ProbeWorkflowMissingError(err)
    }
    throw err
  }

  const [repo, baseline] = await Promise.all([
    getRepo(client, org, CONFIG_REPO),
    client
      .request<{ workflow_runs: { id: number }[] }>(
        `${workflowBase}/runs?event=workflow_dispatch&per_page=1`,
      )
      .catch(rethrowMissingWorkflow),
  ])
  if (!repo) {
    throw new Error(
      `${org}/${CONFIG_REPO} not found; run setup for this org first`,
    )
  }
  const ref = repo.default_branch || DEFAULT_BRANCH
  const sinceRunId = baseline.workflow_runs?.[0]?.id ?? null

  await client
    .request(`${workflowBase}/dispatches`, { method: "POST", body: { ref } })
    .catch(rethrowMissingWorkflow)

  logWorkflows.info("dispatched probe-token", { org, sinceRunId })
  return { sinceRunId }
}

// Re-run the failed jobs of a run in <org>/classroom50 (the banner's retry).
// Re-running only failed jobs preserves the run id, so the tracker re-binds to
// the same run as it goes back in progress.
export async function rerunFailedRun(
  client: GitHubClient,
  org: string,
  runId: number,
): Promise<void> {
  logWorkflows.info("re-running failed jobs", { org, runId })
  await client.request(
    `/repos/${org}/${CONFIG_REPO}/actions/runs/${runId}/rerun-failed-jobs`,
    { method: "POST" },
  )
}
