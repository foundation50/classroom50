// Dev-only overlay showing the latest GitHub rate-limit counters, so the data
// that used to flood the console per-response is now glanceable and always
// current instead. Mounted only under import.meta.env.DEV (see main.tsx), so it
// never ships to production and needs no i18n (t()) — it's a developer tool.
//
// Rendered through a portal onto document.body (NOT inside the app's React root
// subtree) and position:fixed, so from the website's perspective it doesn't
// exist: it's outside the app's DOM tree, reserves no layout space, and can't be
// matched by the app's own scroll containers or :has()/descendant selectors.

import { useSyncExternalStore, useState, useEffect } from "react"
import { createPortal } from "react-dom"
import { useRouterState } from "@tanstack/react-router"

import router from "@/router"
import {
  getApiCallCount,
  getRateLimitSnapshot,
  subscribeRateLimit,
} from "@/lib/diagnostics/rateLimit"

// Below this fraction of the limit remaining, warn; near-zero, danger. Mirrors
// the "how close am I to a 429" question the overlay exists to answer.
const WARN_FRACTION = 0.2
const DANGER_FRACTION = 0.05

function toneClass(remaining: number | null, limit: number | null): string {
  if (remaining === null || limit === null || limit === 0)
    return "text-base-content"
  const frac = remaining / limit
  if (frac <= DANGER_FRACTION) return "text-error"
  if (frac <= WARN_FRACTION) return "text-warning"
  return "text-success"
}

// Seconds until the rate-limit window resets (GitHub `reset` is epoch seconds).
function secondsUntil(
  resetEpochSec: number | null,
  nowMs: number,
): number | null {
  if (resetEpochSec === null) return null
  return Math.max(0, Math.round(resetEpochSec - nowMs / 1000))
}

export function RateLimitOverlay() {
  const snapshot = useSyncExternalStore(
    subscribeRateLimit,
    getRateLimitSnapshot,
  )
  const totalCalls = useSyncExternalStore(subscribeRateLimit, getApiCallCount)
  const [collapsed, setCollapsed] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // Subscribe to the router directly (this overlay lives outside RouterProvider,
  // mounted at the root) so a route change can rebase the per-view counter.
  const pathname = useRouterState({
    router,
    select: (s) => s.location.pathname,
  })

  // The total-call count captured when the current view loaded; per-view calls
  // are the delta since. Kept in state (not a ref) and rebased via the "derive
  // state during render" pattern so a route change resets it without an effect.
  // Approximate ("~"): baseline (totalCalls) and pathname come from independent
  // stores, so a call firing across a route change can land in either bucket —
  // fine for a dev glance, not an accounting figure.
  const [view, setView] = useState({ path: pathname, baseline: totalCalls })
  if (view.path !== pathname) {
    setView({ path: pathname, baseline: totalCalls })
  }
  const callsThisView = totalCalls - view.baseline

  // Tick once a second only while there's a snapshot to count down toward. Keyed
  // on whether a snapshot exists (not its identity) so a new snapshot object on
  // every response doesn't tear down and re-arm the interval each time.
  const hasSnapshot = snapshot !== null
  useEffect(() => {
    if (!hasSnapshot) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [hasSnapshot])

  const rateLimit = snapshot?.rateLimit ?? null
  const resetIn = secondsUntil(rateLimit?.reset ?? null, now)
  const tone = toneClass(rateLimit?.remaining ?? null, rateLimit?.limit ?? null)

  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[9999] flex justify-center"
      role="status"
      aria-label="GitHub rate limit (dev)"
    >
      <div className="pointer-events-auto flex items-center gap-4 rounded-t-box border border-b-0 border-base-300 bg-base-100/95 px-4 py-1.5 font-mono text-xs shadow-lg backdrop-blur">
        <button
          type="button"
          className="flex items-center gap-2 text-left"
          onClick={() => setCollapsed((c) => !c)}
          title="Toggle GitHub rate-limit details"
        >
          <span className="opacity-60">this view</span>
          <span>~{callsThisView} calls</span>
          <span className="opacity-40">{collapsed ? "▸" : "▾"}</span>
        </button>
        {!collapsed && (
          <div className="flex items-center gap-4">
            <span>
              <span className="opacity-60">rate-limit</span>{" "}
              <span className={tone}>
                {rateLimit?.remaining ?? "?"}/{rateLimit?.limit ?? "?"}
              </span>
            </span>
            <span>
              <span className="opacity-60">resource</span>{" "}
              {rateLimit?.resource ?? "—"}
            </span>
            <span>
              <span className="opacity-60">session total</span> {totalCalls}
            </span>
            <span>
              <span className="opacity-60">resets in</span>{" "}
              {resetIn === null ? "—" : `${resetIn}s`}
            </span>
            {rateLimit?.retryAfter != null && (
              <span className="text-error">
                <span className="opacity-60">retry-after</span>{" "}
                {rateLimit.retryAfter}s
              </span>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
