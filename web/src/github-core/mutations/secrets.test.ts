import { describe, expect, it, vi } from "vitest"

import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"
import { putRepoVariable } from "./secrets"
import type { GitHubClient } from "../client"

const noRateLimit: GitHubRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const apiError = (status: number) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/x",
    message: `HTTP ${status}`,
    body: null,
    rateLimit: noRateLimit,
  })

describe("putRepoVariable", () => {
  it("PATCHes an existing variable (rotation path)", async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const client = { request } as unknown as GitHubClient

    await putRepoVariable(client, "org", "classroom50", "VAR", "value")

    expect(request).toHaveBeenCalledTimes(1)
    const [path, opts] = request.mock.calls[0]
    expect(path).toBe("/repos/org/classroom50/actions/variables/VAR")
    expect(opts.method).toBe("PATCH")
    expect(opts.body).toEqual({ name: "VAR", value: "value" })
  })

  it("falls back to POST when the variable does not exist yet (404)", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(apiError(404))
      .mockResolvedValueOnce(undefined)
    const client = { request } as unknown as GitHubClient

    await putRepoVariable(client, "org", "classroom50", "VAR", "value")

    expect(request).toHaveBeenCalledTimes(2)
    const [createPath, createOpts] = request.mock.calls[1]
    expect(createPath).toBe("/repos/org/classroom50/actions/variables")
    expect(createOpts.method).toBe("POST")
    expect(createOpts.body).toEqual({ name: "VAR", value: "value" })
  })

  it("rethrows a non-404 error", async () => {
    const request = vi.fn().mockRejectedValue(apiError(403))
    const client = { request } as unknown as GitHubClient

    await expect(
      putRepoVariable(client, "org", "classroom50", "VAR", "value"),
    ).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("throws when the owner is missing", async () => {
    const request = vi.fn()
    const client = { request } as unknown as GitHubClient
    await expect(
      putRepoVariable(client, undefined, "classroom50", "VAR", "value"),
    ).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
})
