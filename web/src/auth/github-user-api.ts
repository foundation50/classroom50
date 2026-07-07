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

// Validate a pasted PAT against GET /user and surface the granted scopes in one
// call, so the PAT sign-in path can block on missing scopes before completing.
// `scopes` is the X-OAuth-Scopes header: a string for classic PATs (and OAuth
// tokens), or `null` when absent (e.g. a fine-grained PAT) — the caller must
// treat null as "unknown", not "no scopes", matching useMissingScopes.
export async function fetchGithubUserWithScopes(
  token: string,
): Promise<{ user: GitHubUser; scopes: string | null }> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  })

  if (!res.ok) {
    throw new GitHubUserFetchError(res.status)
  }

  return {
    user: await res.json(),
    scopes: res.headers.get("x-oauth-scopes"),
  }
}
