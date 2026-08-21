import type { GitHubClient } from "./client"
import type { GitHubRepo } from "./types"
import { GitHubAPIError, tolerateGitHubError } from "./errors"

export async function getRepo(
  client: GitHubClient,
  owner: string,
  repo: string,
) {
  return tolerateGitHubError(
    () =>
      client.request<GitHubRepo>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      ),
    null,
  )
}

// Authoritative "does this repo have any commits?" probe, used as the tiebreaker
// when GET /repos reports size 0 (an async, lagging value: a freshly-pushed repo
// with real commits reads size 0 for minutes — issue #544). List-branches is the
// robust signal because a settled repo returns a well-formed 200 array in every
// state: a non-empty array iff the repo has at least one commit, an empty array
// iff it is commitless (verified: a truly-empty repo returns 200 []). It needs
// no default_branch (phantom on a commitless repo).
//
// Tri-state: true = has commits, false = definitely commitless, null =
// inconclusive (transient/unknown error) so the caller applies its own
// fail-direction rather than manufacturing a false "empty" verdict. Only a 404
// (repo gone) is a definite empty. A 409 "Git Repository is empty." is NOT
// treated as empty: it's the fresh-repo warmup window (the same #544 scenario)
// that this codebase treats as transient/retryable elsewhere (see gh-student's
// isFreshRepoRetryable), so it's inconclusive and fails open.
export async function hasAnyCommits(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<boolean | null> {
  try {
    const branches = await client.request<unknown[]>(
      `/repos/${owner}/${repo}/branches?per_page=1`,
    )
    // A malformed non-array 200 body is inconclusive, not "has commits".
    return Array.isArray(branches) ? branches.length > 0 : null
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 404) {
      return false
    }
    return null
  }
}
