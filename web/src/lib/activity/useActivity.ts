import { useMemo, useSyncExternalStore } from "react"

import {
  activityForOrg,
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
} {
  const snapshot = useSyncExternalStore(subscribeActivity, getActivitySnapshot)

  // Newest-first, org-scoped, TTL-applied view. Derives from activityForOrg so
  // the reactive timeline uses the SAME filter+TTL contract as readActivity()
  // and the diagnostics snapshot. `snapshot` is the store's live entries array
  // (same reference activityForOrg reads); depending on it re-derives on every
  // store mutation. activityForOrg returns most-recent-last, so reverse.
  const entries = useMemo(
    () => activityForOrg(org).slice().reverse(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, org],
  )

  return { entries }
}
