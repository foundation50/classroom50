import type { GitHubUser } from "@/hooks/github/types"

// Carries the HTTP status so callers can branch on auth failures (401) without
// string-matching the message — e.g. the session-expiry effect in useGithubAuth.
export class GitHubUserFetchError extends Error {
  status: number

  constructor(status: number) {
    super(`GitHub API: HTTP ${status}`)
    this.name = "GitHubUserFetchError"
    this.status = status
  }
}

export async function fetchGithubUser(token: string): Promise<GitHubUser> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  })

  if (!res.ok) {
    throw new GitHubUserFetchError(res.status)
  }

  return res.json()
}
