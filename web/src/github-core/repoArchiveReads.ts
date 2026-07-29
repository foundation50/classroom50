import type { GitHubClient } from "./client"
import { tolerateGitHubError } from "./errors"
import { withGithubReadSlot, retryOnRateLimit } from "./queries"

export type RepoArchive = {
  bytes: ArrayBuffer
  filename: string
}

// Fetch a repo's latest source as a zip archive. No ref means GitHub archives
// the default-branch HEAD — for an assignment repo that is the student's latest
// push, i.e. their latest submission. A missing or empty repo 404s, which we
// tolerate as `null` so a bulk download can skip it rather than aborting the
// whole batch. `filename` falls back to `<repo>.zip` when GitHub omits the
// Content-Disposition header.
//
// Routed through the shared read slot + rate-limit retry so a bulk fan-out
// shares the one global per-repo budget (archives are heavier than JSON reads,
// so bursting past it trips GitHub's secondary limits) and backs off once on a
// throttle instead of dropping the repo into `failed`.
export async function fetchRepoArchive(
  client: GitHubClient,
  owner: string,
  repo: string,
  options?: { signal?: AbortSignal },
): Promise<RepoArchive | null> {
  return tolerateGitHubError(
    () =>
      withGithubReadSlot(() =>
        retryOnRateLimit(async () => {
          const { bytes, filename } = await client.fetchArchive(owner, repo, {
            signal: options?.signal,
          })
          return { bytes, filename: filename ?? `${repo}.zip` }
        }),
      ),
    null,
  )
}
