import type { GitHubClient } from "./client"
import type { GitHubRepo } from "./types"
import { GitHubAPIError, tolerateGitHubError } from "./errors"

export async function getRepo(
  client: GitHubClient,
  owner: string,
  repo: string,
) {
  return tolerateGitHubError(
    () => client.request<GitHubRepo>(`/repos/${owner}/${repo}`),
    null,
  )
}

// Authoritative "does this repo have any commits?" probe, used as the tiebreaker
// when GET /repos reports size 0 (an async, lagging value: a freshly-pushed repo
// with real commits reads size 0 for minutes — issue #544). List-branches is the
// robust signal because it returns a well-formed 200 array in every state: a
// non-empty array iff the repo has at least one commit, an empty array iff it is
// commitless. Unlike list-commits / git-refs (which 409 on an empty repo — a
// status this codebase already reads as a transient fresh-repo lag to retry, see
// gh-student's isFreshRepoRetryable), branches has no such overlap, and it needs
// no default_branch (phantom on a commitless repo).
//
// Tri-state: true = has commits, false = definitely commitless, null =
// inconclusive (transient/unknown error) so the caller applies its own
// fail-direction rather than manufacturing a false "empty" verdict. A 404 (repo
// gone) or a 409 "Git Repository is empty." both mean definitely-empty.
export async function hasAnyCommits(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<boolean | null> {
  try {
    const branches = await client.request<unknown[]>(
      `/repos/${owner}/${repo}/branches?per_page=1`,
    )
    return branches.length > 0
  } catch (err) {
    if (
      err instanceof GitHubAPIError &&
      (err.status === 404 || err.status === 409)
    ) {
      return false
    }
    return null
  }
}
