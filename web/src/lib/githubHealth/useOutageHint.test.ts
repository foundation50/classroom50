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
  recordGitHubSuccess,
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

// Trip suspicion the way the app does: >= 3 outage-shaped failures in the window.
function suspectOutage() {
  const base = Date.now()
  recordGitHubFailure(apiError(500), base)
  recordGitHubFailure(apiError(500), base + 100)
  recordGitHubFailure(apiError(500), base + 200)
}

beforeEach(() => __resetGitHubHealthForTest())
afterEach(() => __resetGitHubHealthForTest())

describe("useOutageHint", () => {
  it("does not hint when no outage is suspected, even for an outage-shaped error", () => {
    const { result } = renderHook(() => useOutageHint())
    expect(result.current(apiError(500))).toBe(false)
    expect(result.current(new TypeError("Failed to fetch"))).toBe(false)
  })

  it("hints for an outage-shaped error once an outage is suspected", () => {
    const { result } = renderHook(() => useOutageHint())
    act(() => suspectOutage())
    expect(result.current(apiError(503))).toBe(true)
    expect(result.current(new TypeError("Failed to fetch"))).toBe(true)
  })

  it("never hints for a definitive 4xx or rate limit, even when suspected", () => {
    const { result } = renderHook(() => useOutageHint())
    act(() => suspectOutage())
    expect(result.current(apiError(404))).toBe(false)
    expect(result.current(apiError(403))).toBe(false)
    expect(result.current(apiError(429))).toBe(false)
  })

  it("stops hinting after a success clears suspicion (partial-outage flicker)", () => {
    const { result } = renderHook(() => useOutageHint())
    act(() => suspectOutage())
    expect(result.current(apiError(500))).toBe(true)
    // A single success mid-outage clears the window and suspicion.
    act(() => recordGitHubSuccess())
    expect(result.current(apiError(500))).toBe(false)
  })
})
