import { useCallback, useMemo, useSyncExternalStore } from "react"

import {
  clearActivity,
  getActivitySnapshot,
  subscribeActivity,
  type ActivityEntry,
} from "@/lib/activity/activityStore"

// Reactive access to the session Activity store. The store is module-level (fed
// by non-React code — MutationCache.onError, window handlers, the notification
// provider), so this hook only subscribes React to it via useSyncExternalStore.
// No provider component is needed: the store's lifetime is the tab, not a React
// subtree.
export function useActivity(org: string | undefined): {
  entries: ActivityEntry[]
  clear: () => void
} {
  const snapshot = useSyncExternalStore(subscribeActivity, getActivitySnapshot)

  // Most-recent-first, org-scoped view derived from the raw snapshot.
  const entries = useMemo(() => {
    if (!org) return []
    return snapshot.filter((e) => e.org === org).slice().reverse()
  }, [snapshot, org])

  const clear = useCallback(() => clearActivity(), [])

  return { entries, clear }
}
