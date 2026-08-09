import { describe, expect, it, vi } from "vitest"
import type { GitHubClient } from "./client"
import { GitHubAPIError } from "./errors"
import { hasAnyCommits } from "./repoReads"

const rateLimit = {
  limit: 0,
  remaining: 0,
  reset: 0,
  used: 0,
  resource: null,
  retryAfter: null,
}

function apiError(status: number, message = ""): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: "/repos/o/r/branches",
    message,
    body: {},
    rateLimit,
  })
}

function clientReturning(impl: (path: string) => Promise<unknown>): {
  client: GitHubClient
  paths: string[]
} {
  const paths: string[] = []
  const request = vi.fn(async (path: string) => {
    paths.push(path)
    return impl(path)
  })
  return { client: { request } as unknown as GitHubClient, paths }
}

describe("hasAnyCommits", () => {
  it("returns true when the repo has at least one branch", async () => {
    const { client } = clientReturning(async () => [{ name: "main" }])
    expect(await hasAnyCommits(client, "o", "r")).toBe(true)
  })

  it("returns false for a commitless repo (empty branch array)", async () => {
    const { client } = clientReturning(async () => [])
    expect(await hasAnyCommits(client, "o", "r")).toBe(false)
  })

  it("probes exactly the paginated branches endpoint (one cheap request)", async () => {
    const { client, paths } = clientReturning(async () => [{ name: "main" }])
    await hasAnyCommits(client, "o", "r")
    expect(paths).toEqual(["/repos/o/r/branches?per_page=1"])
  })

  it("treats a 409 'Git Repository is empty.' as inconclusive (fresh-repo warmup)", async () => {
    const { client } = clientReturning(async () => {
      throw apiError(409, "Git Repository is empty.")
    })
    expect(await hasAnyCommits(client, "o", "r")).toBeNull()
  })

  it("treats a 404 (repo gone) as definitely empty", async () => {
    const { client } = clientReturning(async () => {
      throw apiError(404, "Not Found")
    })
    expect(await hasAnyCommits(client, "o", "r")).toBe(false)
  })

  it("returns null (inconclusive) on a malformed non-array 200 body", async () => {
    const { client } = clientReturning(async () => ({ message: "nope" }))
    expect(await hasAnyCommits(client, "o", "r")).toBeNull()
  })

  it("returns null (inconclusive) on a transient server error", async () => {
    const { client } = clientReturning(async () => {
      throw apiError(500, "Server Error")
    })
    expect(await hasAnyCommits(client, "o", "r")).toBeNull()
  })

  it("returns null (inconclusive) on a non-GitHub error", async () => {
    const { client } = clientReturning(async () => {
      throw new Error("network down")
    })
    expect(await hasAnyCommits(client, "o", "r")).toBeNull()
  })
})
