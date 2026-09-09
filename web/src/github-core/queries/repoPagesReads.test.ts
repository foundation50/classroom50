import { describe, expect, it, vi } from "vitest"

import { getRepoPages } from "./repoPagesReads"
import { GitHubAPIError } from "../errors"
import type { GitHubClient } from "../client"

function apiError(status: number): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: "/repos/cs50/r/pages",
    message: `HTTP ${status}`,
    body: null,
    rateLimit: {
      limit: null,
      remaining: null,
      used: null,
      reset: null,
      resource: null,
      retryAfter: null,
    },
  })
}

function makeClient(outcome: unknown) {
  const request = vi.fn(async () => {
    if (outcome instanceof GitHubAPIError) throw outcome
    return outcome
  })
  return { request } as unknown as GitHubClient
}

describe("getRepoPages", () => {
  it("returns the site info", async () => {
    const info = {
      html_url: "https://cs50.github.io/r/",
      build_type: "workflow",
    }
    expect(await getRepoPages(makeClient(info), "cs50", "r")).toEqual(info)
  })

  it("reads a 404 as no site", async () => {
    expect(
      await getRepoPages(makeClient(apiError(404)), "cs50", "r"),
    ).toBeNull()
  })

  it("rethrows other failures", async () => {
    await expect(
      getRepoPages(makeClient(apiError(500)), "cs50", "r"),
    ).rejects.toThrow()
  })
})
