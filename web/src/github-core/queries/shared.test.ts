import { describe, expect, it, vi } from "vitest"

import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"
import {
  retryOnRateLimit,
  withFreshRepoRetry,
  withGithubReadSlot,
  withRetry,
} from "./shared"

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

describe("withRetry", () => {
  const always = () => true

  it("stops after `attempts` and rethrows the last error", async () => {
    const fn = vi.fn().mockRejectedValue(plainError(500))
    await expect(
      withRetry(fn, { attempts: 3, shouldRetry: always, waitMs: () => 0 }),
    ).rejects.toMatchObject({ status: 500 })
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it("gives up at once when waitMs returns null", async () => {
    const fn = vi.fn().mockRejectedValue(plainError(500))
    await expect(
      withRetry(fn, { attempts: 3, shouldRetry: always, waitMs: () => null }),
    ).rejects.toMatchObject({ status: 500 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("does not retry once the signal is aborted, and aborts a wait in progress", async () => {
    const controller = new AbortController()
    const fn = vi.fn().mockRejectedValue(plainError(500))
    const pending = withRetry(fn, {
      attempts: 3,
      shouldRetry: always,
      waitMs: () => 10_000,
      signal: controller.signal,
    })
    await Promise.resolve()
    controller.abort(new DOMException("Aborted", "AbortError"))
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("reports each retry with its wait", async () => {
    const onRetry = vi.fn()
    const fn = vi
      .fn()
      .mockRejectedValueOnce(plainError(500))
      .mockRejectedValueOnce(plainError(502))
      .mockResolvedValue("ok")
    await expect(
      withRetry(fn, {
        attempts: 3,
        shouldRetry: always,
        waitMs: (_err, attempt) => attempt + 1,
        onRetry,
      }),
    ).resolves.toBe("ok")
    expect(onRetry.mock.calls).toEqual([
      [0, 1],
      [1, 2],
    ])
  })
})

describe("withFreshRepoRetry", () => {
  it("caps each wait at maxDelayMs and forwards the retry hook", async () => {
    const onRetry = vi.fn()
    const fn = vi
      .fn()
      .mockRejectedValueOnce(plainError(404))
      .mockRejectedValueOnce(plainError(404))
      .mockRejectedValueOnce(plainError(404))
      .mockResolvedValue("ok")
    await expect(
      withFreshRepoRetry(fn, {
        attempts: 5,
        baseDelayMs: 1,
        backoffFactor: 4,
        maxDelayMs: 5,
        onRetry,
      }),
    ).resolves.toBe("ok")
    // 1, 4, then 16 capped to 5.
    expect(onRetry.mock.calls).toEqual([
      [0, 1],
      [1, 4],
      [2, 5],
    ])
  })

  it("does not retry a non-lag error", async () => {
    const fn = vi.fn().mockRejectedValue(plainError(500))
    await expect(
      withFreshRepoRetry(fn, { attempts: 4, baseDelayMs: 0 }),
    ).rejects.toMatchObject({ status: 500 })
    expect(fn).toHaveBeenCalledTimes(1)
  })
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

  it("does not retry a non-rate-limit error (e.g., 403 scope gap, 500)", async () => {
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
