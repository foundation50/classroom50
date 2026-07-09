// Latest observed GitHub rate-limit headers, for the dev-only RateLimitOverlay.
// Module-level (not React state) because the publisher is the fetch client —
// a plain function outside React, exactly like the Activity store's feeds. The
// client calls publishRateLimit() on every response; the overlay reads it via
// useSyncExternalStore.
//
// Dev-diagnostic only: this is not persisted and carries no PII — just the
// x-ratelimit-* counters GitHub returns on every response.

import type { GitHubRateLimit } from "@/hooks/github/errors"

// The stored snapshot plus when we observed it (epoch ms), so the overlay can
// show "as of Ns ago" and a reset countdown.
export type RateLimitSnapshot = {
  rateLimit: GitHubRateLimit
  at: number
}

let current: RateLimitSnapshot | null = null
const listeners = new Set<() => void>()

// Monotonic count of GitHub API calls made through the client this session,
// incremented at the client's single request choke point. The overlay reads it
// and snapshots the value on each route change to derive "calls in this view".
let apiCallCount = 0

// Called by the GitHub client at its request choke point (covers request +
// requestRaw). Monotonic; the overlay derives per-view counts by diffing.
export function countApiCall(): void {
  apiCallCount += 1
  for (const l of listeners) l()
}

export function getApiCallCount(): number {
  return apiCallCount
}

// Called by the GitHub client on every response. Replaces the old per-response
// `log.debug("rate limit headers", …)` that flooded the console.
export function publishRateLimit(rateLimit: GitHubRateLimit): void {
  current = { rateLimit, at: Date.now() }
  for (const l of listeners) l()
}

export function subscribeRateLimit(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getRateLimitSnapshot(): RateLimitSnapshot | null {
  return current
}
