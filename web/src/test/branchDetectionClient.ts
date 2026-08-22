// Shared branch-mode read router for the submission-detection hook tests.
//
// Both branch-mode readers issue the same three reads — the repo object (for
// `default_branch`), the `.classroom50.yaml` marker commit list (the baseline),
// and the default-branch commit log — so their tests would otherwise each
// hand-roll the same URL router. Test infra under src/test/, not app code.

import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"

const noRateLimit: GitHubRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

export const apiError = (status: number) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/x",
    message: `HTTP ${status}`,
    body: null,
    rateLimit: noRateLimit,
  })

export type BranchClientOptions = {
  // `null` models a not-accepted repo: the real client REJECTS with 404 and
  // getRepo's tolerateGitHubError converts it to null, so rejecting here (not
  // resolving null) is what exercises that path.
  defaultBranch?: string | null
  baselineCommits?: Array<{ sha: string }>
  branchCommits?: Array<{ sha: string; message?: string }>
}

// Branch commits get a representative `commit` payload (the real list-commits
// response always carries one) so detection can read the commit time.
export function branchClient(opts: BranchClientOptions) {
  return (url: string) => {
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return opts.defaultBranch === null
        ? Promise.reject(apiError(404))
        : Promise.resolve({ default_branch: opts.defaultBranch ?? "main" })
    }
    if (url.includes("path=.classroom50.yaml")) {
      return Promise.resolve(opts.baselineCommits ?? [])
    }
    if (url.includes("/commits?sha=")) {
      return Promise.resolve(
        (opts.branchCommits ?? []).map((c) => ({
          sha: c.sha,
          commit: {
            message: c.message ?? c.sha,
            committer: { date: "2026-06-20T10:00:00Z" },
          },
        })),
      )
    }
    return Promise.resolve([])
  }
}
