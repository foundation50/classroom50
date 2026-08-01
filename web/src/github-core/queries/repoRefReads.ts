import { queryOptions } from "@tanstack/react-query"

import type { GitHubClient } from "../client"
import type {
  GitHubBranchRef,
  GitHubCommitRef,
  GitHubPullRequest,
  GitHubRepo,
} from "../types"
import { CONFIG_REPO, DEFAULT_BRANCH } from "@/util/configRepo"
import { tolerateGitHubError } from "../errors"
import { paginateAll } from "../paginate"
import { githubKeys } from "./keys"

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

// The OLDEST commit touching `path` on the default branch, or null when none
// do. Used to recover the accept commit (the one that created
// .classroom50.yaml) — the same resolution rule as the runner's baseline_sha().
// Paginated to exhaustion because a wrong SHA is worse than a slow read: the
// runner refuses to maintain a Feedback PR whose base isn't the baseline it
// resolves, and a single page would hand back a NEWER commit once the marker's
// history exceeds 100 entries.
export async function getOldestCommitShaForPath(
  client: GitHubClient,
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  const commits = await paginateAll<{ sha: string }>(
    client,
    (page) =>
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?path=${encodeURIComponent(path)}&per_page=100&page=${page}`,
  )
  if (!commits.length) return null
  // Newest-first, so the last entry is the accept commit.
  return commits[commits.length - 1].sha
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

export async function getOrgRepos(client: GitHubClient, owner: string) {
  // Paginate to exhaustion: a single per_page=100 page silently under-counts
  // orgs with >100 repos, making repo-list-derived signals (e.g., assignment
  // acceptance on the submissions dashboard) miss students in large orgs. A
  // first-page 404 surfaces as null.
  return tolerateGitHubError(
    () =>
      paginateAll<GitHubRepo>(
        client,
        (page) => `/orgs/${owner}/repos?per_page=100&page=${page}&type=all`,
      ),
    null,
  )
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
