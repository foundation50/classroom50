import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"

import { rateLimitWaitMs, retryDelayForGitHubError } from "@/github-core/errors"

// Retries React Query has scheduled behind a GitHub rate limit, keyed by query
// hash: the instant each retry fires. Derived from the same delay the client
// applies, so the countdown matches the real wait.
type PendingRetry = { firesAt: number }

// Seconds until the soonest rate-limited retry fires, or null when no query is
// waiting on a rate limit. A gate that shows a spinner while its reads retry
// renders this so a throttled user sees why the wait is long and when it ends,
// instead of an unexplained spinner for up to the retry cap.
export function useRateLimitWait(): number | null {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<Map<string, PendingRetry>>(
    () => new Map(),
  )
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "removed") {
        setPending((prev) => without(prev, event.query.queryHash))
        return
      }
      if (event.type !== "updated") return
      const { action, query } = event
      if (action.type === "failed") {
        if (rateLimitWaitMs(action.error) === null) return
        const delay = retryDelayForGitHubError(
          action.failureCount,
          action.error,
        )
        // Stamp the clock here too, so a fresh retry renders with the right
        // countdown before the first interval tick.
        const at = Date.now()
        setNow(at)
        setPending((prev) =>
          new Map(prev).set(query.queryHash, { firesAt: at + delay }),
        )
        return
      }
      // The retry ran (success or final error), the fetch was cancelled
      // (setState reverts it), or a new fetch started.
      if (
        action.type === "success" ||
        action.type === "error" ||
        action.type === "fetch" ||
        action.type === "setState"
      ) {
        setPending((prev) => without(prev, query.queryHash))
      }
    })
  }, [queryClient])

  const soonest = soonestOf(pending)

  useEffect(() => {
    if (soonest === null) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [soonest])

  if (soonest === null) return null
  return Math.max(0, Math.ceil((soonest - now) / 1000))
}

function without(map: Map<string, PendingRetry>, hash: string) {
  if (!map.has(hash)) return map
  const next = new Map(map)
  next.delete(hash)
  return next
}

function soonestOf(map: Map<string, PendingRetry>): number | null {
  let soonest: number | null = null
  for (const { firesAt } of map.values()) {
    if (soonest === null || firesAt < soonest) soonest = firesAt
  }
  return soonest
}
