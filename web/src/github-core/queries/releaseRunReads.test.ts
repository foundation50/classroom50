import { describe, expect, it, vi } from "vitest"

import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"
import { getServiceTokenStatus } from "./releaseRunReads"
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

const clientThrowing = (err: unknown): GitHubClient =>
  ({ request: vi.fn().mockRejectedValue(err) }) as unknown as GitHubClient

// getServiceTokenStatus resolves only DEFINITIVE verdicts (404 -> missing,
// 403 -> unknown/permission_denied) and rethrows everything else. Resolving a
// transient error to "unknown" would let an invalidation refetch overwrite the
// optimistically-seeded "present" (useSaveServiceToken) and bounce the setup
// wizard off its derived finish stage (#310).
describe("getServiceTokenStatus", () => {
  it("resolves 'missing' on a 404", async () => {
    const status = await getServiceTokenStatus(
      clientThrowing(apiError(404)),
      "org",
    )
    expect(status.status).toBe("missing")
  })

  it("resolves 'unknown' (permission_denied) on a 403", async () => {
    const status = await getServiceTokenStatus(
      clientThrowing(apiError(403)),
      "org",
    )
    expect(status.status).toBe("unknown")
    expect(status.status === "unknown" && status.reason).toBe(
      "permission_denied",
    )
  })

  it("rethrows a transient 5xx instead of resolving 'unknown'", async () => {
    await expect(
      getServiceTokenStatus(clientThrowing(apiError(503)), "org"),
    ).rejects.toThrow()
  })

  it("rethrows a network/timeout error instead of resolving 'unknown'", async () => {
    await expect(
      getServiceTokenStatus(
        clientThrowing(new TypeError("Failed to fetch")),
        "org",
      ),
    ).rejects.toThrow()
  })
})
