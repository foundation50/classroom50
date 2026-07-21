import { describe, expect, it, vi } from "vitest"

import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"
import { retryOnRateLimit, withGithubReadSlot } from "./shared"

const noRateLimit: GitHubRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const rateLimitedError = (retryAfter: number | null = 0) =>
  new GitHubAPIError({
    status: 429,
    url: "https://api.github.com/x",
    message: "rate limited",
    body: null,
    rateLimit: { ...noRateLimit, retryAfter },
  })

const plainError = (status: number) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/x",
    message: `HTTP ${status}`,
    body: null,
    rateLimit: noRateLimit,
  })

describe("retryOnRateLimit", () => {
  it("returns the result when the call succeeds first try", async () => {
    const fn = vi.fn().mockResolvedValue("ok")
    await expect(retryOnRateLimit(fn)).resolves.toBe("ok")
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("retries once on a rate-limit error, then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitedError(0))
      .mockResolvedValueOnce("ok")
    await expect(retryOnRateLimit(fn)).resolves.toBe("ok")
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("throws if the rate-limit persists past the single retry", async () => {
    const fn = vi.fn().mockRejectedValue(rateLimitedError(0))
    await expect(retryOnRateLimit(fn)).rejects.toBeInstanceOf(GitHubAPIError)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("does not retry a non-rate-limit error (e.g. 403 scope gap, 500)", async () => {
    const fn = vi.fn().mockRejectedValue(plainError(500))
    await expect(retryOnRateLimit(fn)).rejects.toBeInstanceOf(GitHubAPIError)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("does not retry a plain rejection that is not a GitHubAPIError", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    await expect(retryOnRateLimit(fn)).rejects.toBeInstanceOf(TypeError)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe("withGithubReadSlot", () => {
  it("bounds concurrent reads to the shared cap across interleaved callers", async () => {
    let inFlight = 0
    let peak = 0
    const release: Array<() => void> = []

    // 20 tasks that each block until we release them, so we can observe the
    // peak simultaneous count the semaphore permits.
    const tasks = Array.from({ length: 20 }, () =>
      withGithubReadSlot(async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise<void>((resolve) => release.push(resolve))
        inFlight--
      }),
    )

    // Let the scheduler admit the first wave, then drain everything.
    await Promise.resolve()
    await Promise.resolve()
    while (release.length > 0) {
      release.shift()!()
      await Promise.resolve()
      await Promise.resolve()
    }
    await Promise.all(tasks)

    // REPO_READ_CONCURRENCY is 8; the shared semaphore must never exceed it
    // even though 20 tasks were queued at once.
    expect(peak).toBeLessThanOrEqual(8)
    expect(peak).toBeGreaterThan(0)
  })
})
