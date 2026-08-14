import { useCallback, useRef } from "react"

import { useReducedMotion } from "./useReducedMotion"

// How long to wait before measuring. The disclosure bodies animate open with
// collapseVariants (DURATION.base = 150ms), so measuring earlier would read a
// mid-animation height and under-scroll.
const SETTLE_MS = 200

// Extra breathing room kept below the revealed content so it doesn't sit flush
// against the viewport edge.
const BOTTOM_MARGIN_PX = 24

// Auto-scroll a just-expanded disclosure into view, following the usual
// disclosure-pattern rules:
//   - Only scroll when the content is actually clipped. Yanking the page when
//     the panel already fits is the classic over-correction, and it steals the
//     reading position from a user who expanded something they could already
//     see.
//   - Scroll the minimum needed, and never past the toggle itself: the user's
//     click anchor has to stay on screen or the page feels like it jumped
//     somewhere unrelated.
//   - Honor the motion preference: "smooth" only when motion is allowed, since
//     a smooth programmatic scroll is exactly what reduce-motion users opt out
//     of (WCAG 2.3.3).
// Returns a ref to put on the collapsible body plus the callback to run when it
// expands.
export function useRevealOnExpand() {
  const { reduced } = useReducedMotion()
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const timer = useRef<number | undefined>(undefined)

  const reveal = useCallback(() => {
    if (typeof window === "undefined") return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const body = bodyRef.current
      if (!body) return
      const rect = body.getBoundingClientRect()
      const viewport = window.innerHeight
      const overflow = rect.bottom + BOTTOM_MARGIN_PX - viewport
      // Already fully visible: leave the page where the user put it.
      if (overflow <= 0) return
      // Cap the scroll so the toggle above the body stays in view; a taller
      // panel then simply fills the viewport from its top edge.
      const maxScroll = Math.max(0, rect.top - BOTTOM_MARGIN_PX)
      window.scrollBy({
        top: Math.min(overflow, maxScroll),
        behavior: reduced ? "auto" : "smooth",
      })
    }, SETTLE_MS)
  }, [reduced])

  return { bodyRef, reveal }
}

export default useRevealOnExpand
