import type { GitHubClient } from "./client"
import type { GitHubWorkflowRun } from "./types"
import { GitHubAPIError } from "./errors"

// Repo-wide Actions runs for the org's classroom50 config repo, powering the
// activity banner. Split out of queries.ts so this self-contained cluster (its
// query key + the single repo-runs fetch) lives on its own.

export const activityRunsKey = (owner: string) =>
  ["github", "repo-actions-runs", owner, "active-and-recent"] as const

// Runs to pull in one page. GitHub returns runs newest-first, so one unfiltered
// page covers both active and recently-finished runs.
const RUNS_PER_PAGE = 50

// The most-recent Actions runs across every workflow in <org>/classroom50,
// newest first — ONE unfiltered request (the page holds both active runs and
// the recently-completed ones the banner reads conclusions from).
//
// A 404 (repo missing / not a classroom50 org / not visible) means "no runs" ->
// []. A 403/429/5xx (rate limit, lost Actions read, outage) MUST propagate so
// React Query marks the query errored — otherwise the banner would show a false
// "all clear". Aborts also propagate.
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
    // Newest-first already, but sort defensively so ordering never depends on it.
    return (res.workflow_runs ?? []).sort((a, b) => b.id - a.id)
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof GitHubAPIError && error.isNotFound) return []
    throw error
  }
}
