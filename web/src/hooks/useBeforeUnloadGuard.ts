import { useEffect } from "react"

// Ask the browser to confirm before the tab closes or navigates away while
// `active`. Browsers show their own generic prompt (custom text is ignored), so
// the in-page copy must say why the tab should stay open.
//
// The prompt also needs sticky user activation: the browser shows it only if
// the user has clicked, tapped, or typed somewhere in the page since it loaded.
// A page that was just (re)loaded and never touched closes silently even while
// this guard is active; Chrome logs "Blocked attempt to show a 'beforeunload'
// confirmation panel" when it vetoes one. That is a platform rule with no
// opt-out, not a missing guard.
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
      // Legacy fallback (Chrome/Edge < 119 ignore preventDefault): any truthy
      // returnValue works there; the empty string is Chrome-only lore.
      event.returnValue = true
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [active])
}

export default useBeforeUnloadGuard
