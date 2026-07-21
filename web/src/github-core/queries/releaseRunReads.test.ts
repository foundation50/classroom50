import { describe, expect, it, vi } from "vitest"

import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"
import {
  getServiceTokenStatus,
  latestSubmitReleaseWithAssets,
} from "./releaseRunReads"
import type { GitHubClient } from "../client"
import type { GitHubRelease } from "../types"

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

const clientReturning = (releases: GitHubRelease[]): GitHubClient =>
  ({ request: vi.fn().mockResolvedValue(releases) }) as unknown as GitHubClient

const release = (
  tag: string,
  when: string,
  extra: Partial<GitHubRelease> = {},
): GitHubRelease => ({
  id: 1,
  tag_name: tag,
  name: tag,
  html_url: `https://github.com/o/r/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  created_at: when,
  published_at: when,
  ...extra,
})

describe("latestSubmitReleaseWithAssets", () => {
  it("returns the newest submit/* release among several", async () => {
    const client = clientReturning([
      release("submit/2026-01-01T00:00:00Z-aaaa", "2026-01-01T00:00:00Z"),
      release("submit/2026-03-01T00:00:00Z-cccc", "2026-03-01T00:00:00Z"),
      release("submit/2026-02-01T00:00:00Z-bbbb", "2026-02-01T00:00:00Z"),
    ])
    const latest = await latestSubmitReleaseWithAssets(client, "o", "r")
    expect(latest?.tag_name).toBe("submit/2026-03-01T00:00:00Z-cccc")
  })

  it("ignores non-submit/* tags", async () => {
    const client = clientReturning([
      release("v1.0.0", "2026-05-01T00:00:00Z"),
      release("submit/2026-01-01T00:00:00Z-aaaa", "2026-01-01T00:00:00Z"),
    ])
    const latest = await latestSubmitReleaseWithAssets(client, "o", "r")
    expect(latest?.tag_name).toBe("submit/2026-01-01T00:00:00Z-aaaa")
  })

  it("returns null when there are no submit/* releases", async () => {
    const client = clientReturning([release("v1.0.0", "2026-05-01T00:00:00Z")])
    expect(await latestSubmitReleaseWithAssets(client, "o", "r")).toBeNull()
  })

  it("returns null on a 404 (repo not accepted)", async () => {
    const client = clientThrowing(apiError(404))
    expect(await latestSubmitReleaseWithAssets(client, "o", "r")).toBeNull()
  })

  it("rethrows a non-404 error (e.g. 403) rather than hiding it as no-submission", async () => {
    await expect(
      latestSubmitReleaseWithAssets(clientThrowing(apiError(403)), "o", "r"),
    ).rejects.toThrow()
  })

  it("carries the release's assets through for the caller", async () => {
    const client = clientReturning([
      release("submit/2026-01-01T00:00:00Z-aaaa", "2026-01-01T00:00:00Z", {
        assets: [
          {
            id: 9,
            name: "result.json",
            browser_download_url: "https://github.com/o/r/releases/download/x",
          },
        ],
      }),
    ])
    const latest = await latestSubmitReleaseWithAssets(client, "o", "r")
    expect(latest?.assets?.[0]?.name).toBe("result.json")
  })
})
