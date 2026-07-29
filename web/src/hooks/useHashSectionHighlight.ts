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

// Scrolls the `#id` section into view and briefly highlights it on a hash
// deep-link (from a cross-page link or a click on the section's own anchor
// heading). Returns the highlighted id so a section can gate its ring.
//
// This is the single owner of the deep-link scroll, so a click never competes
// with a second scroll; the hash is left in the URL so it stays shareable. The
// scroll retries on a rAF because a section can mount after its data loads.
// `scrollNonce` (history state, bumped by SectionAnchorHeading) lets an
// identical-hash re-click re-fire, since TanStack no-ops a same-hash navigation.
export function useHashSectionHighlight(): string | null {
  const { hash, scrollNonce } = useRouterState({
    select: (s) => ({
      hash: s.location.hash,
      scrollNonce: (s.location.state as { scrollNonce?: number } | undefined)
        ?.scrollNonce,
    }),
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
