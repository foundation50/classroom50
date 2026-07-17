// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"

import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"

// The store fires a best-effort githubstatus.com probe once suspicion trips;
// stub it so the hook tests never hit the network.
vi.mock("./githubStatusApi", () => ({
  fetchGitHubStatusIndicator: () => Promise.resolve(null),
}))

import {
  __resetGitHubHealthForTest,
  recordGitHubFailure,
} from "./githubHealthStore"
import { useOutageHint } from "./useOutageHint"

const noRateLimit: GitHubRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const apiError = (status: number, over: Partial<GitHubRateLimit> = {}) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/x",
    message: `HTTP ${status}`,
    body: null,
    rateLimit: { ...noRateLimit, ...over },
  })

// A friendly wrapper that preserves the original error as `.cause`, mirroring
// AcceptStepError / any rethrown wrapper the app produces.
class WrapperError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "WrapperError"
    if (cause !== undefined) this.cause = cause
  }
}

beforeEach(() => __resetGitHubHealthForTest())
afterEach(() => __resetGitHubHealthForTest())

describe("useOutageHint().isOutage — strict, false-positive-proof", () => {
  it("is true for a 5xx and a network TypeError (regardless of suspicion)", () => {
    const { result } = renderHook(() => useOutageHint())
    expect(result.current.isOutage(apiError(500))).toBe(true)
    expect(result.current.isOutage(apiError(503))).toBe(true)
    expect(result.current.isOutage(new TypeError("Failed to fetch"))).toBe(true)
  })

  it("is false for definitive 4xx, rate limits, and aborts", () => {
    const { result } = renderHook(() => useOutageHint())
    expect(result.current.isOutage(apiError(401))).toBe(false)
    expect(result.current.isOutage(apiError(403))).toBe(false)
    expect(result.current.isOutage(apiError(404))).toBe(false)
    expect(result.current.isOutage(apiError(429))).toBe(false)
    expect(result.current.isOutage(apiError(403, { retryAfter: 60 }))).toBe(
      false,
    )
    expect(
      result.current.isOutage(new DOMException("aborted", "AbortError")),
    ).toBe(false)
  })

  it("is false for a bare/unknown error (no false positive on a plain throw)", () => {
    const { result } = renderHook(() => useOutageHint())
    // A TemplateAccessError-like plain Error with no outage cause.
    expect(result.current.isOutage(new Error("ask your teacher"))).toBe(false)
    expect(result.current.isOutage("some string")).toBe(false)
    expect(result.current.isOutage(undefined)).toBe(false)
  })

  it("unwraps `.cause` — a wrapper around a 5xx hints, around a 404 does not", () => {
    const { result } = renderHook(() => useOutageHint())
    expect(
      result.current.isOutage(new WrapperError("failed", apiError(502))),
    ).toBe(true)
    expect(
      result.current.isOutage(
        new WrapperError("failed", new TypeError("Failed to fetch")),
      ),
    ).toBe(true)
    // Definitive causes must never read as an outage through the wrapper.
    expect(
      result.current.isOutage(new WrapperError("not found", apiError(404))),
    ).toBe(false)
    expect(
      result.current.isOutage(new WrapperError("rate limited", apiError(429))),
    ).toBe(false)
    // A wrapper with no cause is not an outage (e.g. TemplateAccessError).
    expect(result.current.isOutage(new WrapperError("ask teacher"))).toBe(false)
  })
})

describe("useOutageHint().suspected — background signal", () => {
  it("reflects the detector: false until tripped, true after 3 failures in the window", () => {
    const { result, rerender } = renderHook(() => useOutageHint())
    expect(result.current.suspected).toBe(false)
    act(() => {
      const base = Date.now()
      recordGitHubFailure(apiError(500), base)
      recordGitHubFailure(apiError(500), base + 100)
      recordGitHubFailure(apiError(500), base + 200)
    })
    rerender()
    expect(result.current.suspected).toBe(true)
  })
})
