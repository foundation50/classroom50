import type { GitHubClient } from "./client"
import type { GitHubRepo } from "./types"
import { tolerateGitHubError } from "./errors"

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
