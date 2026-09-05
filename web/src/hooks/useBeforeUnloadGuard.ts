import { useEffect } from "react"

// Ask the browser to confirm before the tab closes or navigates away while
// `active`. Browsers show their own generic prompt (custom text is ignored), so
// the in-page copy must say why the tab should stay open.
//
// Two ways to hold the tab, pick by who owns the chain:
// - A mutation hook whose mutationFn chains several GitHub writes declares
//   `meta: { keepTabOpen: true }`; KeepTabOpenGuard reads it off the mutation
//   cache, so the hold survives the page unmounting mid-run.
// - A component that fans out itself (a bulk modal looping single-write
//   mutations, or calling domain functions directly) calls this hook with its
//   own running flag.
// Listeners compose: any active guard is enough to prompt.
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
