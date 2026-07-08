import { describe, expect, it, vi } from "vitest"

import { probeOrgClassroom50Status } from "./useOrgClassroom50Status"
import { GitHubAPIError } from "./github/errors"
import { CONFIG_REPO_MARKER_REL, ORG_GITHUB_DIR } from "@/skeleton/skeleton"

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

function clientReturning(impl: (path: string) => Promise<unknown>) {
  return { request: vi.fn(impl) }
}

// A client that resolves the repo GET but 404s the marker file — the
// name-collision shape (some org owns an unrelated repo literally named
// `classroom50`).
function clientNameCollision() {
  return clientReturning(async (path: string) => {
    if (path.includes("/contents/")) throw apiError(404)
    return { id: 1 }
  })
}

describe("probeOrgClassroom50Status", () => {
  it("returns 'ready' when the repo resolves AND carries the config marker", async () => {
    const client = clientReturning(async () => ({ id: 1 }))

    await expect(probeOrgClassroom50Status(client, "acme")).resolves.toBe(
      "ready",
    )
    expect(client.request).toHaveBeenCalledWith("/repos/acme/classroom50")
    expect(client.request).toHaveBeenCalledWith(
      `/repos/acme/classroom50/contents/${ORG_GITHUB_DIR}/${CONFIG_REPO_MARKER_REL}`,
    )
  })

  it("returns 'missing' for a name collision (repo exists but has no config marker)", async () => {
    const client = clientNameCollision()

    await expect(probeOrgClassroom50Status(client, "acme")).resolves.toBe(
      "missing",
    )
  })

  it("returns 'missing' on a 404 (repo unset or private to me)", async () => {
    const client = clientReturning(async () => {
      throw apiError(404)
    })

    await expect(probeOrgClassroom50Status(client, "acme")).resolves.toBe(
      "missing",
    )
  })

  it("returns 'ready' when the marker probe fails open on a non-404 (repo OK, blip on the marker read)", async () => {
    // Distinct from the 403 rethrow below: there the repo GET itself fails; here
    // the repo resolves and only the marker read blips. The helper fails open so
    // a real teacher's org is never hidden behind a transient marker read.
    const client = clientReturning(async (path: string) => {
      if (path.includes("/contents/")) throw apiError(403)
      return { id: 1 }
    })

    await expect(probeOrgClassroom50Status(client, "acme")).resolves.toBe(
      "ready",
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
