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

// Fetch one page of <org>/classroom50 Actions runs, newest-first. Shared by the
// banner poll (listActiveAndRecentRuns) and the timeline page
// (listWorkflowRunsPage): both hit the same endpoint with the same error
// contract — a 404 (repo missing / not a classroom50 org / not visible) means
// "no runs" -> [], while 403/429/5xx (rate limit, lost Actions read, outage)
// MUST propagate so React Query marks the query errored — else the banner shows
// a false "all clear". Aborts also propagate. Sort is defensive (the API is
// already newest-first) so ordering never depends on it.
async function fetchRunsPage(
  client: GitHubClient,
  org: string,
  query: string,
  signal?: AbortSignal,
): Promise<GitHubWorkflowRun[]> {
  try {
    const res = await client.request<{ workflow_runs: GitHubWorkflowRun[] }>(
      `/repos/${encodeURIComponent(org)}/classroom50/actions/runs?${query}`,
      { method: "GET", signal },
    )
    return (res.workflow_runs ?? []).sort((a, b) => b.id - a.id)
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof GitHubAPIError && error.isNotFound) return []
    throw error
  }
}

// The most-recent Actions runs across every workflow in <org>/classroom50,
// newest first — ONE unfiltered request (the page holds both active runs and
// the recently-completed ones the banner reads conclusions from).
export async function listActiveAndRecentRuns(
  client: GitHubClient,
  org: string,
  signal?: AbortSignal,
): Promise<GitHubWorkflowRun[]> {
  return fetchRunsPage(client, org, `per_page=${RUNS_PER_PAGE}`, signal)
}

// A specific page of <org>/classroom50 runs for the org Activity timeline
// (browse/audit view), distinct from listActiveAndRecentRuns which the banner
// polls under its own key. Paginated so the timeline can "load older"; kept on a
// separate key so paging the audit view never disturbs the banner's poll cache.
export const workflowRunsPageKey = (owner: string, page: number) =>
  ["github", "repo-actions-runs", owner, "page", page] as const

export async function listWorkflowRunsPage(
  client: GitHubClient,
  org: string,
  page: number,
  perPage = 30,
  signal?: AbortSignal,
): Promise<GitHubWorkflowRun[]> {
  return fetchRunsPage(client, org, `per_page=${perPage}&page=${page}`, signal)
}
