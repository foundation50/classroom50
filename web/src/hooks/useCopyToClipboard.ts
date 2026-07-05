import { useEffect, useRef, useState } from "react"

// Copies text and flips a `copied` flag that auto-resets after `resetMs`.
// Clears the pending reset before re-arming and on unmount; leaves `copied`
// false if the write rejects (e.g. a non-secure context).
export function useCopyToClipboard(text: string, resetMs = 2000) {
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(
    () => () => {
      mountedRef.current = false
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    },
    [],
  )

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      // Guard against unmount during the await.
      if (!mountedRef.current) return
      setCopied(true)
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
      resetTimerRef.current = setTimeout(() => setCopied(false), resetMs)
    } catch {
      if (mountedRef.current) setCopied(false)
    }
  }

  // Clear the flag and any pending timer immediately (e.g. when the copy text
  // changes so a stale "Copied" doesn't linger).
  const reset = () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    resetTimerRef.current = null
    setCopied(false)
  }

  return { copied, copy, reset }
}
