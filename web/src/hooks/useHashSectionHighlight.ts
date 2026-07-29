import { useEffect, useState } from "react"
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
// The hash is left in the URL so it stays shareable/bookmarkable. The scroll
// retries on a rAF because a section can mount after its data loads, so the
// element may not exist on the tick the hash first arrives.
export function useHashSectionHighlight(): string | null {
  const hash = useRouterState({ select: (s) => s.location.hash })
  const [highlightedId, setHighlightedId] = useState<string | null>(null)

  useEffect(() => {
    if (!hash) return

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
  }, [hash])

  return highlightedId
}

export default useHashSectionHighlight
