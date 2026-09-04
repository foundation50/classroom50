import { useEffect } from "react"

// Ask the browser to confirm before the tab closes or navigates away while
// `active`. Browsers show their own generic prompt (custom text is ignored), so
// the in-page copy must say why the tab should stay open.
export function useBeforeUnloadGuard(active: boolean) {
  useEffect(() => {
    if (!active) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Legacy browsers only honor a set returnValue.
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [active])
}

export default useBeforeUnloadGuard
