import { queryOptions } from "@tanstack/react-query"

import type { GitHubClient } from "../client"
import type { GitHubRelease, GitHubWorkflowRun } from "../types"
import { CONFIG_REPO } from "@/util/configRepo"
import { GitHubAPIError, tolerateGitHubError } from "../errors"
import { COLLECT_SCORES_WORKFLOW, REGRADE_WORKFLOW } from "../workflows"
import { getErrorMessage } from "../errorMessage"
import { githubKeys } from "./keys"

// The submission-tag convention written by the autograde runner: each graded
// push publishes a `submit/<timestamp>-<sha>` release whose body GitHub renders
// as the score + per-test table. We list these and link students straight to
// the release page rather than reading result.json.
const SUBMISSION_TAG_PREFIX = "submit/"

// published_at is null for a draft; fall back to created_at so ordering holds.
function releaseTime(release: GitHubRelease): number {
  return new Date(release.published_at ?? release.created_at).getTime()
}

// All graded-submission releases for a student's repo, newest first. A repo
// with no releases yet (or a first push still grading) returns []. The release
// page shows the rendered grade, so we only need the metadata.
export function releasesQuery(
  client: GitHubClient,
  owner: string,
  repo: string,
) {
  return queryOptions({
    queryKey: githubKeys.releases(owner, repo),
    queryFn: ({ signal }): Promise<GitHubRelease[]> =>
      // A missing repo (student hasn't accepted, or a previewing teacher with
      // no repo) 404s here — no releases, so [] falls through to the empty
      // state. Other errors throw.
      tolerateGitHubError(async () => {
        const releases = await client.request<GitHubRelease[]>(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
            repo,
          )}/releases?per_page=100`,
          { method: "GET", signal },
        )

        return releases
          .filter((r) => r.tag_name.startsWith(SUBMISSION_TAG_PREFIX))
          .sort((a, b) => releaseTime(b) - releaseTime(a))
      }, []),
    enabled: Boolean(owner && repo),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

type RepositorySecret = {
  name: string
  created_at: string
  updated_at: string
}
const SERVICE_TOKEN_SECRET_NAME = "CLASSROOM50_SERVICE_TOKEN"
export type ServiceTokenStatus =
  | {
      status: "present"
      secretName: typeof SERVICE_TOKEN_SECRET_NAME
      createdAt: string
      updatedAt: string
      message: string
    }
  | {
      status: "missing"
      secretName: typeof SERVICE_TOKEN_SECRET_NAME
      message: string
    }
  | {
      status: "unknown"
      secretName: typeof SERVICE_TOKEN_SECRET_NAME
      reason: "repo_missing_or_no_access" | "permission_denied" | "unknown"
      message: string
    }

export async function getServiceTokenStatus(
  client: GitHubClient,
  org: string,
): Promise<ServiceTokenStatus> {
  try {
    const secret = await client.request<RepositorySecret>(
      `/repos/${org}/${CONFIG_REPO}/actions/secrets/${SERVICE_TOKEN_SECRET_NAME}`,
    )

    return {
      status: "present",
      secretName: SERVICE_TOKEN_SECRET_NAME,
      createdAt: secret.created_at,
      updatedAt: secret.updated_at,
      message: `Service token is set on the ${CONFIG_REPO} config repo. Last updated ${new Date(
        secret.updated_at,
      ).toLocaleString()}.`,
    }
  } catch (err) {
    if (err instanceof GitHubAPIError) {
      if (err.status === 404) {
        return {
          status: "missing",
          secretName: SERVICE_TOKEN_SECRET_NAME,
          message: `Service token is not set on the ${CONFIG_REPO} config repo. Score-collection and regrade workflows cannot access student repositories until a service token is set.`,
        }
      }

      if (err.status === 403) {
        return {
          status: "unknown",
          secretName: SERVICE_TOKEN_SECRET_NAME,
          reason: "permission_denied",
          message: `Could not check the service token on the ${CONFIG_REPO} config repo because this GitHub authorization cannot read repository Actions secrets.`,
        }
      }
    }

    return {
      status: "unknown",
      secretName: SERVICE_TOKEN_SECRET_NAME,
      reason: "unknown",
      message: `Could not check the service token on the ${CONFIG_REPO} config repo: ${getErrorMessage(
        err,
      )}`,
    }
  }
}

// Fetches the most recent workflow run matching the given filters (or null) from
// a classroom50 workflow. Shared by the collect-scores "track my dispatch" /
// "last collected" reads and the regrade dispatch tracker, so the workflow file
// is a parameter (defaults to collect-scores).
async function listLatestWorkflowRun(
  client: GitHubClient,
  org: string,
  filters: {
    event?: string
    since?: string
    status?: string
    perPage?: number
    page?: number
  },
  signal?: AbortSignal,
  workflow: string = COLLECT_SCORES_WORKFLOW,
): Promise<GitHubWorkflowRun[]> {
  const params = new URLSearchParams({
    per_page: String(filters.perPage ?? 1),
  })
  if (filters.event) params.set("event", filters.event)
  if (filters.since) params.set("created", `>=${filters.since}`)
  if (filters.status) params.set("status", filters.status)
  if (filters.page) params.set("page", String(filters.page))

  const res = await client.request<{ workflow_runs: GitHubWorkflowRun[] }>(
    `/repos/${org}/${CONFIG_REPO}/actions/workflows/${workflow}/runs?${params.toString()}`,
    { method: "GET", signal },
  )

  return res.workflow_runs ?? []
}

// Finds the run we dispatched: run ids are monotonic, so it's the oldest
// dispatch run with an id greater than `sinceRunId` (the newest id before our
// POST). Binding to our own run avoids mistaking a concurrent dispatch for ours
// and needs no clock. Null until our run registers; `sinceRunId === null` means
// no prior runs, so the oldest run on the first page is ours.
export async function getCollectScoresRunAfterId(
  client: GitHubClient,
  org: string,
  sinceRunId: number | null,
  signal?: AbortSignal,
): Promise<GitHubWorkflowRun | null> {
  const runs = await listLatestWorkflowRun(
    client,
    org,
    { event: "workflow_dispatch", perPage: 20 },
    signal,
  )

  // runs come newest-first; the run we triggered is the oldest one newer than
  // the pre-dispatch baseline.
  const newer =
    sinceRunId === null ? runs : runs.filter((r) => r.id > sinceRunId)
  return newer.length > 0 ? newer[newer.length - 1] : null
}

// Finds the regrade run we dispatched, by the same monotonic-id binding as
// getCollectScoresRunAfterId but against regrade.yaml. Null until our run
// registers.
//
// Unlike collect (one org-wide dispatcher), regrade can fan out one dispatch per
// student via the per-row buttons, so far more than a page of dispatch runs can
// pile up between our snapshot and this poll. A fixed first page would let our
// own run scroll off and bind us to a later student's run. So we page
// newest-first, accumulating only runs with id > sinceRunId, and stop once a
// page contains a run at/below the baseline (everything older is irrelevant) or
// we hit the page cap. The bound run is the oldest such run.
const REGRADE_RUNS_PER_PAGE = 30
const REGRADE_MAX_PAGES = 10

export async function getRegradeRunAfterId(
  client: GitHubClient,
  org: string,
  sinceRunId: number | null,
  signal?: AbortSignal,
): Promise<GitHubWorkflowRun | null> {
  // No prior runs: our run is the oldest dispatch run that exists, so a single
  // newest-first page is enough — the last entry is the earliest run.
  if (sinceRunId === null) {
    const runs = await listLatestWorkflowRun(
      client,
      org,
      { event: "workflow_dispatch", perPage: REGRADE_RUNS_PER_PAGE },
      signal,
      REGRADE_WORKFLOW,
    )
    return runs.length > 0 ? runs[runs.length - 1] : null
  }

  // Page through dispatch runs (newest-first) collecting those newer than the
  // baseline. Stop once a page reaches the baseline or yields nothing.
  const newer: GitHubWorkflowRun[] = []
  for (let page = 1; page <= REGRADE_MAX_PAGES; page++) {
    const runs = await listLatestWorkflowRun(
      client,
      org,
      { event: "workflow_dispatch", perPage: REGRADE_RUNS_PER_PAGE, page },
      signal,
      REGRADE_WORKFLOW,
    )
    if (runs.length === 0) break

    for (const r of runs) {
      if (r.id > sinceRunId) newer.push(r)
    }

    // This page already includes the baseline (or older), so no later page can
    // hold a run newer than it — we've seen every candidate.
    if (runs.some((r) => r.id <= sinceRunId)) break
  }

  // The run we triggered is the oldest one newer than the baseline.
  return newer.length > 0 ? newer[newer.length - 1] : null
}

// The most recent *completed* collect-scores run (cron or manual), or null if
// the workflow has never completed. Used for the "last collected" timestamp;
// status=completed stops an in-flight newer run from hiding the prior one.
export async function getLastCollectScoresRun(
  client: GitHubClient,
  org: string,
  signal?: AbortSignal,
): Promise<GitHubWorkflowRun | null> {
  const runs = await listLatestWorkflowRun(
    client,
    org,
    { status: "completed" },
    signal,
  )
  return runs[0] ?? null
}
