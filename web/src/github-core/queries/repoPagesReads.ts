import type { GitHubClient } from "../client"
import { GitHubAPIError } from "../errors"

// GET /repos/{owner}/{repo}/pages. `html_url` reflects an org custom Pages
// domain; `status` is the last build's state.
export type RepoPagesInfo = {
  html_url?: string
  cname?: string | null
  build_type?: "legacy" | "workflow" | null
  source?: { branch: string; path: string }
  status?: "built" | "building" | "errored" | null
  public?: boolean
}

// `null` when no site is configured (404); any other failure throws.
export async function getRepoPages(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<RepoPagesInfo | null> {
  try {
    return await client.request<RepoPagesInfo>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pages`,
    )
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) return null
    throw err
  }
}
