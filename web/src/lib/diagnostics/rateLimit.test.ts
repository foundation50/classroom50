import { afterEach, describe, expect, it, vi } from "vitest"

import type { GitHubRateLimit } from "@/hooks/github/errors"
import {
  countApiCall,
  getApiCallCount,
  getRateLimitSnapshot,
  publishRateLimit,
  subscribeRateLimit,
} from "./rateLimit"

const sample = (remaining: number): GitHubRateLimit => ({
  limit: 5000,
  remaining,
  used: 5000 - remaining,
  reset: Math.floor(Date.now() / 1000) + 3600,
  resource: "core",
  retryAfter: null,
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("rateLimit store", () => {
  it("returns the most recently published snapshot", () => {
    publishRateLimit(sample(4999))
    expect(getRateLimitSnapshot()?.rateLimit.remaining).toBe(4999)
    publishRateLimit(sample(4998))
    expect(getRateLimitSnapshot()?.rateLimit.remaining).toBe(4998)
  })

  it("stamps the snapshot with an observation time", () => {
    const before = Date.now()
    publishRateLimit(sample(100))
    const at = getRateLimitSnapshot()?.at ?? 0
    expect(at).toBeGreaterThanOrEqual(before)
  })

  it("notifies subscribers on publish and stops after unsubscribe", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeRateLimit(listener)
    publishRateLimit(sample(10))
    publishRateLimit(sample(9))
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    publishRateLimit(sample(8))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("counts API calls monotonically and notifies subscribers", () => {
    const before = getApiCallCount()
    const listener = vi.fn()
    const unsubscribe = subscribeRateLimit(listener)
    countApiCall()
    countApiCall()
    expect(getApiCallCount()).toBe(before + 2)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
})
