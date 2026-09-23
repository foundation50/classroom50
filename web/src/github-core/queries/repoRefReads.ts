import { queryOptions } from "@tanstack/react-query"

import type { GitHubClient } from "../client"
import type {
  GitHubBranchRef,
  GitHubCommitRef,
  GitHubPullRequest,
  GitHubRepo,
} from "../types"
import { CONFIG_REPO, DEFAULT_BRANCH } from "@/util/configRepo"
import { isShimBackfillCommit } from "@/util/commit"
import { tolerateGitHubError } from "../errors"
import {
  PAGE_FETCH_CONCURRENCY,
  paginateAll,
  paginateFirstPage,
  paginateRemaining,
  withTransientRetry,
} from "../paginate"
import { getRepo } from "../repoReads"
import { githubKeys } from "./keys"
import { withGithubReadSlot } from "./shared"

export function getBranchRefRepo(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
) {
  return client.request<GitHubBranchRef>(
    `/repos/${owner}/${repo}/git/ref/heads/${branch}`,
  )
}

export function branchRefQuery(client: GitHubClient, org: string) {
  return queryOptions({
    queryKey: githubKeys.branchRef(org),
    queryFn: ({ signal }) =>
      client.request<GitHubBranchRef>(
        `/repos/${org}/${CONFIG_REPO}/git/ref/heads/${DEFAULT_BRANCH}`,
        { method: "GET", signal },
      ),
    enabled: Boolean(org),
    staleTime: 60 * 1000,
    retry: false,
  })
}

export function getCommitByRepo(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
) {
  return client.request<GitHubCommitRef>(
    `/repos/${owner}/${repo}/git/commits/${branch}`,
  )
}

// The accept-marker baseline: the OLDEST commit touching `.classroom50.yaml`,
// the same resolution rule as the runner's baseline_sha(). Null when no commit
// does (a bare or no_autograder repo). `backfilled` marks the one case where
// that oldest commit must NOT anchor anything: the enable-autograder backfill
// introduced it, so the repo was accepted without a marker and its baseline is
// the root commit (a Feedback PR frozen there would otherwise mismatch the
// runner for the repo's whole life). Paginated to exhaustion because a wrong
// SHA is worse than a slow read: a single page would hand back a NEWER commit
// once the marker's history exceeds 100 entries.
export type MarkerBaseline = { sha: string; backfilled: boolean }

export async function getMarkerBaseline(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<MarkerBaseline | null> {
  const commits = await paginateAll<{
    sha: string
    commit?: { message?: string }
  }>(
    client,
    (page) =>
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?path=${encodeURIComponent(MARKER_PATH)}&per_page=100&page=${page}`,
  )
  // Newest-first, so the last entry is the commit that introduced the marker.
  const oldest = commits.at(-1)
  if (!oldest) return null
  return {
    sha: oldest.sha,
    backfilled: isShimBackfillCommit(oldest.commit?.message ?? ""),
  }
}

// Which commit anchors a repo's baseline, given its marker history and shape.
// The one place the marker -> backfilled -> root rule lives; every reader
// (Feedback PR base, teacher repair, submission detection) decides through it.
//   "marker": the marker's introducing commit (marker.sha).
//   "root":   the branch's root commit: the marker was backfilled (that repo
//             was accepted without one), or there is no marker and the shape
//             says the root is the seed (rootIsBaseline).
//   "none":   no baseline (a bare empty_repo, or a built-in assignment whose
//             accept never finished).
export type BaselineSource = "marker" | "root" | "none"

export function baselineSource(
  marker: MarkerBaseline | null,
  options: { rootIsBaseline?: boolean } = {},
): BaselineSource {
  if (marker && !marker.backfilled) return "marker"
  if (marker?.backfilled || options.rootIsBaseline) return "root"
  return "none"
}

const MARKER_PATH = ".classroom50.yaml"

// The ROOT commit of `branch`, or null on a commitless repo. The Feedback-PR
// and submission baseline for a no_autograder repo, which carries no marker:
// its root is the template (or README) seed, so everything above it is the
// student's. Only the oldest commit matters, so after page 1 reveals the page
// count the walk jumps straight to the last page instead of reading every page
// in between.
export async function getRootCommitSha(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  const makePath = (page: number) =>
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?sha=${encodeURIComponent(branch)}&per_page=100&page=${page}`
  const first = await paginateFirstPage<{ sha: string }>(client, makePath)
  const last =
    first.lastPage === null
      ? first.items
      : await client.request<{ sha: string }[]>(makePath(first.lastPage))
  return last.at(-1)?.sha ?? null
}
export function commitQuery(
  client: GitHubClient,
  org: string,
  branchSha: string,
) {
  return queryOptions({
    queryKey: githubKeys.commitTree(org, branchSha),
    queryFn: ({ signal }) =>
      client.request<GitHubCommitRef>(
        `/repos/${org}/${CONFIG_REPO}/git/commits/${branchSha}`,
        { method: "GET", signal },
      ),
    enabled: Boolean(org && branchSha),
    staleTime: 60 * 1000,
    retry: false,
  })
}

export function repoQuery(client: GitHubClient, owner: string, repo: string) {
  return queryOptions({
    queryKey: githubKeys.repo(owner, repo),
    queryFn: ({ signal }) =>
      client.request<GitHubRepo>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        { method: "GET", signal },
      ),
    enabled: Boolean(owner && repo),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

// The org listing walk: page 1 alone, then the rest concurrently. Oldest first,
// so a repo created while pages are in flight lands after them instead of
// shifting every page (the default is newest first). The longest walk in the
// app, so one late page retries on its own rather than sending the query back
// to page 1.
function orgReposWalk(owner: string, signal: AbortSignal | undefined) {
  return {
    makePath: (page: number) =>
      `/orgs/${owner}/repos?per_page=100&page=${page}&type=all&sort=created&direction=asc`,
    options: { signal, retryPages: true, concurrency: PAGE_FETCH_CONCURRENCY },
  }
}

// Every repo in the org. Paginate to exhaustion: a single per_page=100 page
// silently under-counts orgs with >100 repos, making repo-list-derived signals
// (e.g., assignment acceptance on the submissions dashboard) miss students in
// large orgs. A first-page 404 surfaces as null.
export async function getOrgRepos(
  client: GitHubClient,
  owner: string,
  options: { signal?: AbortSignal } = {},
) {
  const { makePath, options: walk } = orgReposWalk(owner, options.signal)
  return tolerateGitHubError(
    () => paginateAll<GitHubRepo>(client, makePath, walk),
    null,
  )
}

export type AssignmentRepos = {
  // null when the org itself 404s, like getOrgRepos.
  repos: GitHubRepo[] | null
  // Whether `repos` is the whole org listing (and so worth caching as one)
  // rather than page 1 plus the candidates that exist.
  complete: boolean
}

// The org repos a caller will look up by exact name. After page 1 reveals the
// page count, when there are no more candidates left unresolved than pages
// left, each candidate is read directly instead of walking the org: a
// 30-student section in a 9,000-repo org is 30 small requests instead of 89
// heavy pages. Either way the result is a superset of the candidates that
// exist, which the name-filtering consumers read unchanged.
export async function getAssignmentRepos(
  client: GitHubClient,
  owner: string,
  candidateNames: readonly string[],
  options: { signal?: AbortSignal } = {},
): Promise<AssignmentRepos> {
  const { signal } = options
  const { makePath, options: walk } = orgReposWalk(owner, signal)
  return tolerateGitHubError(
    async () => {
      const first = await paginateFirstPage<GitHubRepo>(client, makePath, walk)
      if (first.lastPage !== null) {
        const onFirstPage = new Set(
          first.items.map((repo) => repo.name.toLowerCase()),
        )
        const unresolved = [
          ...new Set(candidateNames.map((name) => name.toLowerCase())),
        ].filter((name) => !onFirstPage.has(name))
        // Same rule as the collect script: never more requests than the pages.
        if (unresolved.length <= first.lastPage - 1) {
          const probed = await probeRepos(client, owner, unresolved, signal)
          return {
            repos: first.items.concat(probed),
            complete: false,
          }
        }
      }
      return {
        repos: await paginateRemaining(client, makePath, first, walk),
        complete: true,
      }
    },
    { repos: null, complete: false },
  )
}

// The candidate repos that exist, read by exact name. Mirrors paginateRemaining:
// one probe failing definitively ends the fan-out and aborts its siblings, and
// the retry waits outside the read slot so a throttled probe does not hold one
// of the few slots while it sleeps. The slot is the only bound: it already caps
// the aggregate wire concurrency, so the fan-out starts every probe and lets
// them queue on it.
async function probeRepos(
  client: GitHubClient,
  owner: string,
  names: readonly string[],
  signal: AbortSignal | undefined,
): Promise<GitHubRepo[]> {
  const fanOut = new AbortController()
  const onCallerAbort = () => fanOut.abort(signal?.reason)
  if (signal?.aborted) onCallerAbort()
  signal?.addEventListener("abort", onCallerAbort, { once: true })
  try {
    const probed = await Promise.all(
      names.map((name) =>
        withTransientRetry(
          () =>
            withGithubReadSlot(() =>
              getRepo(client, owner, name, fanOut.signal),
            ),
          fanOut.signal,
        ),
      ),
    )
    return probed.filter((repo): repo is GitHubRepo => repo !== null)
  } catch (err) {
    fanOut.abort(err)
    throw err
  } finally {
    signal?.removeEventListener("abort", onCallerAbort)
  }
}

// Open PRs on a student/group repo. The autograde workflow opens one Feedback
// PR per repo, so the first open PR is that PR. 404 (repo not generated yet) ->
// []. Tolerant so a missing repo reads as "no PR" rather than throwing.
export async function getOpenPullRequests(
  client: GitHubClient,
  owner: string,
  repo: string,
  signal?: AbortSignal,
) {
  return tolerateGitHubError(
    () =>
      client.request<GitHubPullRequest[]>(
        `/repos/${owner}/${repo}/pulls?state=open&per_page=10`,
        { method: "GET", signal },
      ),
    [],
  )
}

// PRs matching base<-head in ANY state (open/closed/merged), newest first.
// state=all is what makes the accept-time short-circuit cover a closed or merged
// PR, so a re-accept never duplicates one a teacher already merged. Pass `head`
// as a bare branch name — this helper owner-qualifies it ("owner:branch") as the
// GitHub API requires.
export function listPullRequestsByBaseHead(params: {
  client: GitHubClient
  owner: string
  repo: string
  base: string
  head: string
}) {
  const { client, owner, repo, base, head } = params
  return client.request<GitHubPullRequest[]>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?base=${encodeURIComponent(base)}&head=${encodeURIComponent(`${owner}:${head}`)}&state=all&per_page=1`,
  )
}
