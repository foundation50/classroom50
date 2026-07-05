import { GitHubAPIError, readGitHubRateLimitHeaders } from "./errors"

export type GitHubClient = {
  request: <T = unknown>(
    path: string,
    options?: GitHubRequestOptions,
  ) => Promise<T>

  requestRaw: (path: string, options?: GitHubRequestOptions) => Promise<string>
}

export type GitHubRequestOptions = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  body?: unknown
  accept?: string
  signal?: AbortSignal
  headers?: Record<string, string>
}

// A per-response signal about the token's live state, reported to the provider
// for the session/scope banner. Fires on every response (success and error)
// before any throw.
export type GitHubResponseSignal = {
  status: number
  scopes: string | null
}

export function createGitHubClient(args: {
  token: string
  apiBaseUrl?: string
  onResponse?: (signal: GitHubResponseSignal) => void
}): GitHubClient {
  const apiBaseUrl = args.apiBaseUrl ?? "https://api.github.com"

  async function requestInternal(
    path: string,
    options: GitHubRequestOptions = { method: "GET" },
  ): Promise<Response> {
    const url = path.startsWith("http")
      ? path
      : `${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`

    const headers: Record<string, string> = {
      Authorization: `Bearer ${args.token}`,
      Accept: options.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      ...options.headers,
    }

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json"
    }

    const res = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      cache: options.method === "GET" ? "no-store" : undefined,
    })

    // Report the token's live state to the provider before any throw, so the
    // 401/403 revocation path still surfaces. `scopes` is the X-OAuth-Scopes
    // header (`null` when absent, e.g. a fine-grained PAT — distinct from an
    // empty grant); `status` lets the provider distinguish a dead token (401)
    // from a healthy one.
    args.onResponse?.({
      status: res.status,
      scopes: res.headers.get("x-oauth-scopes"),
    })

    const rateLimit = readGitHubRateLimitHeaders(res)
    if (import.meta.env.DEV) {
      console.warn("rate limit headers", rateLimit)
    }

    if (!res.ok) {
      let body: unknown
      const text = await res.text()

      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = text
      }

      if (import.meta.env.DEV) {
        console.warn("body when request fail", body)
      }

      const message =
        typeof body === "object" &&
        body !== null &&
        "message" in body &&
        typeof body.message === "string"
          ? body.message
          : `GitHub API request failed with ${res.status}`

      throw new GitHubAPIError({
        status: res.status,
        url,
        message,
        body,
        rateLimit,
        ssoHeader: res.headers.get("x-github-sso"),
        acceptedScopes: res.headers.get("x-accepted-oauth-scopes"),
        oauthScopes: res.headers.get("x-oauth-scopes"),
      })
    }

    return res
  }

  return {
    async request<T>(path: string, options?: GitHubRequestOptions) {
      const res = await requestInternal(path, options)

      if (res.status === 204 || res.status === 205) {
        return undefined as T
      }

      const text = await res.text()

      if (!text.trim()) {
        return undefined as T
      }

      return JSON.parse(text) as T
    },

    async requestRaw(path: string, options?: GitHubRequestOptions) {
      const res = await requestInternal(path, {
        method: options?.method ?? "GET",
        ...options,
        accept: options?.accept ?? "application/vnd.github.raw+json",
      })

      return await res.text()
    },
  }
}
