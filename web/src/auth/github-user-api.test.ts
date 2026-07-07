import { afterEach, describe, expect, it, vi } from "vitest"

import {
  fetchGithubUser,
  fetchGithubUserWithScopes,
  GitHubUserFetchError,
} from "./github-user-api"

function mockFetch(res: {
  ok: boolean
  status: number
  scopesHeader?: string | null
  body?: unknown
}) {
  const headers = new Headers()
  if (typeof res.scopesHeader === "string") {
    headers.set("x-oauth-scopes", res.scopesHeader)
  }

  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: res.ok,
      status: res.status,
      headers,
      json: async () => res.body ?? {},
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("fetchGithubUser", () => {
  it("returns the parsed user on a 200 response", async () => {
    const user = { id: 1, login: "octocat" }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(user), { status: 200 })),
    )

    await expect(fetchGithubUser("tok")).resolves.toEqual(user)
  })

  it("sends the bearer token and GitHub Accept header", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    await fetchGithubUser("secret-token")

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer secret-token",
          Accept: "application/vnd.github+json",
        },
      }),
    )
  })

  it("throws GitHubUserFetchError carrying status 401 on a revoked token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Bad credentials", { status: 401 })),
    )

    // useGithubAuth's session-expiry logic branches on `status === 401`, so the
    // carried status is the contract this test locks in.
    const error = await fetchGithubUser("tok").catch((e) => e)

    expect(error).toBeInstanceOf(GitHubUserFetchError)
    expect(error).toBeInstanceOf(Error)
    expect(error.status).toBe(401)
    expect(error.name).toBe("GitHubUserFetchError")
  })

  it("carries a non-401 status distinctly so callers can treat 5xx as transient", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    )

    const error = await fetchGithubUser("tok").catch((e) => e)

    expect(error).toBeInstanceOf(GitHubUserFetchError)
    expect(error.status).toBe(500)
  })

  it("preserves the HTTP status in the error message", () => {
    expect(new GitHubUserFetchError(403).message).toBe("GitHub API: HTTP 403")
  })
})

describe("fetchGithubUserWithScopes", () => {
  it("returns the user and the X-OAuth-Scopes header (classic PAT)", async () => {
    mockFetch({
      ok: true,
      status: 200,
      scopesHeader: "repo, workflow",
      body: { login: "octocat" },
    })

    const result = await fetchGithubUserWithScopes("ghp_token")

    expect(result.user).toEqual({ login: "octocat" })
    expect(result.scopes).toBe("repo, workflow")
  })

  it("returns null scopes when the header is absent (fine-grained PAT)", async () => {
    mockFetch({ ok: true, status: 200, body: { login: "octocat" } })

    const result = await fetchGithubUserWithScopes("github_pat_token")

    expect(result.scopes).toBeNull()
  })

  it("throws GitHubUserFetchError carrying the status on a failed response", async () => {
    mockFetch({ ok: false, status: 401 })

    await expect(fetchGithubUserWithScopes("bad")).rejects.toMatchObject({
      name: "GitHubUserFetchError",
      status: 401,
    })
    await expect(fetchGithubUserWithScopes("bad")).rejects.toBeInstanceOf(
      GitHubUserFetchError,
    )
  })
})
