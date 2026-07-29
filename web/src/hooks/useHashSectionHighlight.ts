import { useEffect, useRef, useState } from "react"
import { useRouterState } from "@tanstack/react-router"

// How long the target section keeps its highlight ring after a hash deep-link.
const HIGHLIGHT_MS = 2000

// The ring recipe a section applies while it is the hash deep-link target.
// One source so every Settings section highlights identically.
export function sectionHighlightClass(active: boolean): string {
  return active
    ? "ring-2 ring-primary ring-offset-2 ring-offset-base-100 transition-shadow"
    : "transition-shadow"
}

// Generic hash-fragment deep-link for Settings section headings: when the URL
// carries `#service-token` (etc.) — whether from a cross-page link or a click on
// the section's own anchor heading — scroll the matching `id` into view and
// briefly highlight it. Returns the currently-highlighted id so a section can
// gate its ring on `id === highlightedId`.
//
// This is the single owner of the deep-link scroll, so a click never competes
// with a second scroll. The hash is left in the URL so it stays shareable. The
// scroll retries on a rAF because a section can mount after its data loads, so
// the element may not exist on the tick the hash first arrives.
//
// `scrollNonce` (from history state, bumped by SectionAnchorHeading on click)
// makes an identical-hash re-click still re-fire the effect, since TanStack
// otherwise no-ops a same-hash navigation and the `hash` dep wouldn't change.
export function useHashSectionHighlight(): string | null {
  const hash = useRouterState({ select: (s) => s.location.hash })
  const scrollNonce = useRouterState({
    select: (s) =>
      (s.location.state as { scrollNonce?: number } | undefined)?.scrollNonce,
  })
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  // The (hash, nonce) we last acted on, so a re-render (e.g. the highlight
  // state change) can't fire a second scroll for the same navigation — one
  // smooth scroll per click, never a competing pair.
  const lastKey = useRef<string | null>(null)

  useEffect(() => {
    if (!hash) return
    const key = `${hash}\u0000${scrollNonce ?? ""}`
    if (lastKey.current === key) return
    lastKey.current = key

    let raf = 0
    let clearTimer = 0
    const target = hash

    const tryScroll = (attempt: number) => {
      const el = document.getElementById(target)
      if (!el) {
        // Element not mounted yet (data still loading); retry for a few frames.
        if (attempt < 30)
          raf = window.requestAnimationFrame(() => tryScroll(attempt + 1))
        return
      }
      el.scrollIntoView({ behavior: "smooth", block: "start" })
    }
    tryScroll(0)

    setHighlightedId(target)
    clearTimer = window.setTimeout(() => setHighlightedId(null), HIGHLIGHT_MS)

    return () => {
      window.cancelAnimationFrame(raf)
      window.clearTimeout(clearTimer)
    }
  }, [hash, scrollNonce])

  return highlightedId
}

export default useHashSectionHighlight
