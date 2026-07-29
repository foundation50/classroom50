import type { GitHubClient } from "./client"
import { tolerateGitHubError } from "./errors"

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
export async function fetchRepoArchive(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<RepoArchive | null> {
  return tolerateGitHubError(async () => {
    const { bytes, filename } = await client.fetchArchive(owner, repo)
    return { bytes, filename: filename ?? `${repo}.zip` }
  }, null)
}
