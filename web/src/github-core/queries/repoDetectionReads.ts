import { queryOptions } from "@tanstack/react-query"

import type { GitHubClient } from "../client"
import type { GitHubCommit, GitHubTag } from "../types"
import { tolerateGitHubError } from "../errors"
import { paginateAll } from "../paginate"
import { githubKeys } from "./keys"

// Detection reads for the submission-configuration hybrid model. Unlike the
// release reads (which key off submit/* Releases the autograder publishes),
// these read the raw repo state so the submissions page can count/show a
// branch-mode push or a tag-mode git tag even when no Release exists. Both
// tolerate a 404 (a repo a student hasn't accepted yet) as an empty result.

// The default-branch commit log, newest-first (GitHub's default order). Callers
// exclude the baseline commit and count the rest as branch-mode submissions.
export async function listDefaultBranchCommits(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<GitHubCommit[]> {
  return tolerateGitHubError(
    () =>
      paginateAll<GitHubCommit>(
        client,
        (page) =>
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
            repo,
          )}/commits?sha=${encodeURIComponent(branch)}&per_page=100&page=${page}`,
      ),
    [],
  )
}

// The repo's git tags (GET /tags). Callers match them against the configured
// exact tag or glob to derive tag-mode submissions.
export async function listRepoTags(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<GitHubTag[]> {
  return tolerateGitHubError(
    () =>
      paginateAll<GitHubTag>(
        client,
        (page) =>
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
            repo,
          )}/tags?per_page=100&page=${page}`,
      ),
    [],
  )
}

// One commit's ISO time (committer date, else author date), or null when the
// commit can't be read or carries no date. Used to date a milestone tag —
// the tags list is dateless and only canonical submit/* names encode a time.
export async function getCommitDatetime(
  client: GitHubClient,
  owner: string,
  repo: string,
  sha: string,
): Promise<string | null> {
  const commit = await tolerateGitHubError(
    () =>
      client.request<GitHubCommit>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
          repo,
        )}/commits/${encodeURIComponent(sha)}`,
      ),
    null,
  )
  return commit?.commit.committer?.date ?? commit?.commit.author?.date ?? null
}

export function defaultBranchCommitsQuery(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
) {
  return queryOptions({
    queryKey: githubKeys.defaultBranchCommits(owner, repo, branch),
    queryFn: () => listDefaultBranchCommits(client, owner, repo, branch),
    enabled: Boolean(owner && repo && branch),
    staleTime: 60 * 1000,
    retry: false,
  })
}

export function repoTagsQuery(
  client: GitHubClient,
  owner: string,
  repo: string,
) {
  return queryOptions({
    queryKey: githubKeys.repoTags(owner, repo),
    queryFn: () => listRepoTags(client, owner, repo),
    enabled: Boolean(owner && repo),
    staleTime: 60 * 1000,
    retry: false,
  })
}
