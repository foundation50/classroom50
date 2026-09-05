import { useEffect } from "react"

// Ask the browser to confirm before the tab closes while `active`. The prompt
// text is the browser's own, so in-page copy must say why the tab should stay
// open; and browsers only show it once the user has interacted with the page.
// Multi-write mutation hooks hold the tab via `meta: { keepTabOpen: true }`
// instead (see hooks/mutations/README.md); this is for component-run fan-outs.
export function useBeforeUnloadGuard(active: boolean) {
  useEffect(() => {
    if (!active) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Chrome/Edge < 119 need a truthy returnValue instead.
      event.returnValue = true
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [active])
}

export default useBeforeUnloadGuard
