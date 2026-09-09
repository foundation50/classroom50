import { describe, expect, it, vi } from "vitest"

import {
  classifyPagesEnableError,
  enableRepoPages,
  getRepoPages,
} from "./repoPages"
import { GitHubAPIError } from "../errors"
import type { GitHubClient } from "../client"

const PATH = "/repos/cs50/cs50-fall-2026-site-alice/pages"

function apiError(status: number, message = `HTTP ${status}`): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: PATH,
    message,
    body: { message },
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

function makeClient(outcome: unknown | GitHubAPIError) {
  const request = vi.fn(async () => {
    if (outcome instanceof GitHubAPIError) throw outcome
    return outcome
  })
  return { client: { request } as unknown as GitHubClient, request }
}

describe("enableRepoPages", () => {
  it("POSTs the create body and reports a fresh enable on 201", async () => {
    const { client, request } = makeClient({ html_url: "x" })
    const result = await enableRepoPages(
      client,
      "cs50",
      "cs50-fall-2026-site-alice",
      { build_type: "legacy", source: { branch: "main", path: "/docs" } },
    )
    expect(result).toEqual({ enabled: true, alreadyEnabled: false })
    expect(request).toHaveBeenCalledWith(PATH, {
      method: "POST",
      body: { build_type: "legacy", source: { branch: "main", path: "/docs" } },
    })
  })

  it("treats 409 (site already exists) as enabled without a PUT", async () => {
    const { client, request } = makeClient(apiError(409))
    const result = await enableRepoPages(client, "cs50", "r", {
      build_type: "workflow",
    })
    expect(result).toEqual({ enabled: true, alreadyEnabled: true })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("returns a classified refusal instead of throwing", async () => {
    const err = apiError(
      422,
      "Upgrade to GitHub Pro or make this repository public to enable Pages.",
    )
    const { client } = makeClient(err)
    const result = await enableRepoPages(client, "cs50", "r", {
      build_type: "workflow",
    })
    expect(result).toEqual({ enabled: false, reason: "plan", error: err })
  })
})

describe("classifyPagesEnableError", () => {
  it.each([
    [apiError(422, "Validation Failed: branch does not exist"), "branch"],
    [apiError(403, "Upgrade to GitHub Pro to enable Pages"), "plan"],
    [apiError(403, "Pages creation is disabled for this organization"), "policy"],
    [apiError(403, "Resource not accessible"), "access"],
    [apiError(404), "access"],
    [apiError(500), "unknown"],
    [new Error("network"), "unknown"],
  ])("classifies %s as %s", (err, reason) => {
    expect(classifyPagesEnableError(err)).toBe(reason)
  })
})

describe("getRepoPages", () => {
  it("returns the site info", async () => {
    const info = { html_url: "https://cs50.github.io/r/", build_type: "workflow" }
    const { client } = makeClient(info)
    expect(await getRepoPages(client, "cs50", "r")).toEqual(info)
  })

  it("reads a 404 as no site", async () => {
    const { client } = makeClient(apiError(404))
    expect(await getRepoPages(client, "cs50", "r")).toBeNull()
  })

  it("rethrows other failures", async () => {
    const { client } = makeClient(apiError(500))
    await expect(getRepoPages(client, "cs50", "r")).rejects.toThrow()
  })
})
