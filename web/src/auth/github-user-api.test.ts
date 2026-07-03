import { afterEach, describe, expect, it, vi } from "vitest"

import { fetchGithubUser, GitHubUserFetchError } from "./github-user-api"

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

    // The session-expiry logic in useGithubAuth branches on `status === 401`,
    // so the carried status is the contract this test locks in.
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
