import type { GitHubClient } from "./client"
import type { GitHubWorkflowRun } from "./types"
import { GitHubAPIError } from "./errors"

// Repo-wide Actions runs for the org's classroom50 config repo, powering the
// global activity banner. Split out of the catch-all queries.ts so this
// self-contained cluster (its React Query key + the single repo-runs fetch)
// lives on its own. Only `listActiveAndRecentRuns` and the key are consumed
// elsewhere (useActionActivity); the fetch is internal.

export const activityRunsKey = (owner: string) =>
  ["github", "repo-actions-runs", owner, "active-and-recent"] as const

// How many of the most-recent runs (across ALL workflows) to pull in one page.
// GitHub returns runs newest-first, so a single unfiltered page covers both the
// currently-active runs and the recently-finished ones the banner needs to read
// conclusions from — no need for separate in_progress/queued/completed calls.
const RUNS_PER_PAGE = 50

// The most-recent Actions runs across every workflow in <org>/classroom50,
// newest first. ONE unfiltered request (vs. the former three status-filtered
// calls) — GitHub orders runs by descending id, so this page already contains
// the active runs AND the recently-completed ones the banner evaluates
// status-first for running-vs-finished and, when finished, their conclusion.
//
// Error handling is deliberate: a 404 (the repo doesn't exist / isn't a
// classroom50 org, or the teacher can't see it) legitimately means "no runs" ->
// []. But a 403/429 (rate limit, token lost Actions read) or 5xx is a real
// failure and MUST propagate so React Query marks the query errored — otherwise
// the banner would render a false "all clear" during an outage. Aborts also
// propagate (never cached as a verdict).
export async function listActiveAndRecentRuns(
  client: GitHubClient,
  org: string,
  signal?: AbortSignal,
): Promise<GitHubWorkflowRun[]> {
  try {
    const res = await client.request<{ workflow_runs: GitHubWorkflowRun[] }>(
      `/repos/${encodeURIComponent(
        org,
      )}/classroom50/actions/runs?per_page=${RUNS_PER_PAGE}`,
      { method: "GET", signal },
    )
    // Newest-first already, but sort defensively so downstream ordering (the
    // banner's "leading action") never depends on GitHub's response order.
    return (res.workflow_runs ?? []).sort((a, b) => b.id - a.id)
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof GitHubAPIError && error.isNotFound) return []
    // 403 / 429 / 5xx / network — a real failure. Let it surface so the poll is
    // marked errored rather than silently reading as "nothing running".
    throw error
  }
}
