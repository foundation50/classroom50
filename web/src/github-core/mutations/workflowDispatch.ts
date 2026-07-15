import type { GitHubClient } from "../client"
import { getRepo } from "../repoReads"
import { COLLECT_SCORES_WORKFLOW, REGRADE_WORKFLOW } from "../workflows"
import { CONFIG_REPO, DEFAULT_BRANCH } from "@/util/configRepo"
import { logger } from "@/lib/logger"

const logWorkflows = logger.scope("github:workflows")

/**
 * Dispatches the classroom50 repo's `collect-scores.yaml` workflow (the same
 * nightly job that refreshes `scores.json`) so a teacher can pull fresh
 * submissions on demand.
 *
 * Returns `sinceRunId`: the newest collect-scores dispatch run before this POST
 * (null if none). The dispatch API returns no run id, so the caller finds the
 * triggered run as the oldest dispatch run with a larger id — monotonic, so no
 * clock comparison and unambiguous when dispatches race.
 *
 * @param classroom optional dispatch input to scope collection to one classroom;
 *   callers currently omit it to collect org-wide.
 */
export async function triggerScoreCollection(
  client: GitHubClient,
  org: string | undefined,
  classroom?: string,
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

  await client.request(
    `/repos/${org}/${CONFIG_REPO}/actions/workflows/${COLLECT_SCORES_WORKFLOW}/dispatches`,
    {
      method: "POST",
      body: {
        ref,
        inputs: classroom ? { classroom } : {},
      },
    },
  )

  logWorkflows.info("dispatched collect-scores", { org, classroom, sinceRunId })
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
