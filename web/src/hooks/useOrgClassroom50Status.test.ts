import { describe, expect, it, vi } from "vitest"

import { probeOrgClassroom50Status } from "./useOrgClassroom50Status"
import { GitHubAPIError } from "./github/errors"

// The /$org/* gate redirects an admin to /setup only on "missing", and fails
// open on any other shape. That safety hinges on this probe returning "missing"
// ONLY for a 404 and rethrowing everything else (so the query stays "unknown"
// via undefined data). These tests lock that contract in.

const emptyRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

function apiError(status: number) {
  return new GitHubAPIError({
    status,
    url: `/repos/acme/classroom50`,
    message: `HTTP ${status}`,
    body: null,
    rateLimit: emptyRateLimit,
  })
}

function clientReturning(impl: () => Promise<unknown>) {
  return { request: vi.fn(impl) }
}

describe("probeOrgClassroom50Status", () => {
  it("returns 'ready' when the config repo request resolves", async () => {
    const client = clientReturning(async () => ({ id: 1 }))

    await expect(probeOrgClassroom50Status(client, "acme")).resolves.toBe(
      "ready",
    )
    expect(client.request).toHaveBeenCalledWith("/repos/acme/classroom50")
  })

  it("returns 'missing' on a 404 (repo unset or private to me)", async () => {
    const client = clientReturning(async () => {
      throw apiError(404)
    })

    await expect(probeOrgClassroom50Status(client, "acme")).resolves.toBe(
      "missing",
    )
  })

  it("rethrows a 403 so the query stays 'unknown' (never falsely 'missing')", async () => {
    const client = clientReturning(async () => {
      throw apiError(403)
    })

    await expect(
      probeOrgClassroom50Status(client, "acme"),
    ).rejects.toBeInstanceOf(GitHubAPIError)
  })

  it("rethrows a 500 so a transient blip never reports 'missing'", async () => {
    const client = clientReturning(async () => {
      throw apiError(500)
    })

    await expect(
      probeOrgClassroom50Status(client, "acme"),
    ).rejects.toMatchObject({ status: 500 })
  })

  it("rethrows a non-GitHubAPIError (e.g. a network failure) unchanged", async () => {
    const network = new Error("network down")
    const client = clientReturning(async () => {
      throw network
    })

    await expect(probeOrgClassroom50Status(client, "acme")).rejects.toBe(
      network,
    )
  })
})
