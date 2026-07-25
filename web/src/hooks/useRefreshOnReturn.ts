import { useCallback, useEffect, useEffectEvent, useRef } from "react"

// Refreshes once when the tab regains focus, but only after arm() — GitHub's
// grant page opens in a new tab, so coming back here is the only signal the
// grant may have changed. Without it the org query's long staleTime keeps a
// freshly granted org hidden until the teacher hits Refresh.
export function useRefreshOnReturn(onRefresh: () => void) {
  const armed = useRef(false)

  const handleVisibility = useEffectEvent(() => {
    if (!armed.current || document.visibilityState !== "visible") return
    armed.current = false
    onRefresh()
  })

  useEffect(() => {
    document.addEventListener("visibilitychange", handleVisibility)
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility)
  }, [])

  return useCallback(() => {
    armed.current = true
  }, [])
}

export default useRefreshOnReturn
