import type { GitHubClient } from "../client"
import type { GitHubWorkflowRun, GitHubWorkflowRunList } from "../types"
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

// The one dispatch recipe every trigger shares. The dispatch ref (the config
// repo's default branch) and the newest dispatch run id are independent reads,
// so they run together; the baseline must still precede the POST. Run ids are
// monotonic, so the run this POST creates is the oldest dispatch run whose id
// exceeds `sinceRunId` (the dispatch API itself returns no run id): no clock
// comparison, unambiguous when dispatches race.
//
// `mapError` rewrites a failed baseline read or POST before it propagates
// (probe-token turns a 404 into ProbeWorkflowMissingError); the config-repo
// read is left alone since its "not found" is the same for every workflow.
async function openDispatch(
  client: GitHubClient,
  org: string,
  workflow: string,
  options: { mapError?: (err: unknown) => never } = {},
): Promise<{
  sinceRunId: number | null
  post: (inputs?: Record<string, string>) => Promise<unknown>
}> {
  const base = `/repos/${org}/${CONFIG_REPO}/actions/workflows/${workflow}`
  const rethrow =
    options.mapError ??
    ((err: unknown): never => {
      throw err
    })
  const [repo, baseline] = await Promise.all([
    getRepo(client, org, CONFIG_REPO),
    client
      .request<GitHubWorkflowRunList<Pick<GitHubWorkflowRun, "id">>>(
        `${base}/runs?event=workflow_dispatch&per_page=1`,
      )
      .catch(rethrow),
  ])
  if (!repo) {
    throw new Error(
      `${org}/${CONFIG_REPO} not found; run setup for this org first`,
    )
  }
  const ref = repo.default_branch || DEFAULT_BRANCH
  return {
    sinceRunId: baseline.workflow_runs?.[0]?.id ?? null,
    // A workflow with no declared inputs is dispatched with no `inputs` key at
    // all, as probe-token always was.
    post: (inputs) =>
      client
        .request(`${base}/dispatches`, {
          method: "POST",
          body: inputs === undefined ? { ref } : { ref, inputs },
        })
        .catch(rethrow),
  }
}

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
 * submissions on demand. Returns `sinceRunId` (see openDispatch).
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

  const { sinceRunId, post } = await openDispatch(
    client,
    org,
    COLLECT_SCORES_WORKFLOW,
  )

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

  try {
    try {
      await post({ ...inputs, ...labelInputs })
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
      await post(inputs)
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
 * refreshed by a subsequent collect-scores run. Returns `sinceRunId` (see
 * openDispatch).
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

  const { sinceRunId, post } = await openDispatch(client, org, REGRADE_WORKFLOW)

  // The workflow's `owner` input is optional; only send it when scoping to a
  // single student so an empty string isn't passed as a (no-op) filter.
  const inputs: Record<string, string> = { classroom, assignment }
  if (owner) inputs.owner = owner
  await post(inputs)

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
 * check that exercises every scope the service token needs. No inputs. Returns
 * `sinceRunId` (see openDispatch). A 404 on the workflow (baseline read or
 * dispatch) means the org's skeleton predates probe-token.yaml and surfaces as
 * ProbeWorkflowMissingError.
 */
export async function triggerProbeToken(
  client: GitHubClient,
  org: string | undefined,
): Promise<{ sinceRunId: number | null }> {
  if (!org) throw new Error("org must be specified to probe the service token")

  const { sinceRunId, post } = await openDispatch(
    client,
    org,
    PROBE_TOKEN_WORKFLOW,
    {
      mapError: (err) => {
        if (err instanceof GitHubAPIError && err.isNotFound) {
          throw new ProbeWorkflowMissingError(err)
        }
        throw err
      },
    },
  )
  await post()

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
