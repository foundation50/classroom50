import { queryOptions } from "@tanstack/react-query"

import type { GitHubClient } from "../client"
import type { GitHubBranchRef, GitHubCommitRef, GitHubRepo } from "../types"
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
  // orgs with >100 repos, making repo-list-derived signals (e.g. assignment
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

export async function getRepoPermissionForUser(params: {
  client: GitHubClient
  org: string
  repo: string
  username: string
}): Promise<{ permission?: string; role_name?: string }> {
  const { client, org, repo, username } = params

  return client.request<{ permission?: string; role_name?: string }>(
    `/repos/${org}/${repo}/collaborators/${username}/permission`,
  )
}

export type GitHubPullRequest = {
  number: number
  html_url: string
  state: "open" | "closed"
  title: string
  draft?: boolean
  head: { ref: string }
  base: { ref: string }
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
