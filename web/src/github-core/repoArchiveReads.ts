import type { GitHubClient } from "./client"
import { tolerateGitHubError } from "./errors"
import { withGithubReadSlot, retryOnRateLimit } from "./queries"

export type RepoArchive = {
  bytes: ArrayBuffer
  filename: string
}

// Fetch a repo's latest source zip. No ref → default-branch HEAD, i.e. the
// student's latest push. Missing/empty repo 404s → null, so a bulk run skips it
// instead of aborting. Routed through the shared read slot + rate-limit retry
// so a fan-out shares the one per-repo budget (archives are heavy) and backs
// off once on a throttle rather than dropping the repo to `failed`. `filename`
// defaults to `<repo>.zip` when Content-Disposition is absent.
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
