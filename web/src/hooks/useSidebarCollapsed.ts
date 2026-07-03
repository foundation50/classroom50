import { useSyncExternalStore } from "react"

import {
  SIDEBAR_COLLAPSE_EVENT,
  SIDEBAR_COLLAPSED_KEY,
} from "@/components/drawer"

// Whether the app sidebar is collapsed, read from localStorage for consumers
// OUTSIDE the drawer's React context (the top activity banner mounts above the
// router). Stays in sync via the same-tab SIDEBAR_COLLAPSE_EVENT the drawer
// dispatches on toggle, plus cross-tab `storage` events.
function subscribe(onChange: () => void): () => void {
  window.addEventListener(SIDEBAR_COLLAPSE_EVENT, onChange)
  window.addEventListener("storage", onChange)
  return () => {
    window.removeEventListener(SIDEBAR_COLLAPSE_EVENT, onChange)
    window.removeEventListener("storage", onChange)
  }
}

function getSnapshot(): boolean {
  return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true"
}

export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
