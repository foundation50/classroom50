import { useCallback, useEffect, useRef } from "react"

/**
 * Defers a callback by one macrotask — the confirm-close -> run handoff, so
 * the next dialog doesn't stack over the still-closing confirm. At most one
 * handoff is pending: scheduling again cancels the previous timer, and an
 * unmount cancels whatever is pending so a stray fan-out can't fire.
 */
export function useDeferredRun(): (fn: () => void | Promise<void>) => void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  return useCallback((fn: () => void | Promise<void>) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      void fn()
    }, 0)
  }, [])
}
