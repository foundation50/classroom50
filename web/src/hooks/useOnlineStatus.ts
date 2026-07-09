import { useSyncExternalStore } from "react"

function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange)
  window.addEventListener("offline", onChange)
  return () => {
    window.removeEventListener("online", onChange)
    window.removeEventListener("offline", onChange)
  }
}

function getSnapshot() {
  return navigator.onLine
}

// SSR/tests without a navigator default to online so nothing renders an offline
// state on the server.
function getServerSnapshot() {
  return true
}

// Live browser connectivity, driven by the online/offline events so an offline
// state appears and clears without a reload. navigator.onLine is optimistic (a
// captive portal reads as online), so treat only `false` as authoritative:
// false means no network, true means "probably reachable" — never a claim that
// a specific host is up (that's what the actual fetch is for).
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

export default useOnlineStatus
