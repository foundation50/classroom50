import { useEffect, useRef } from "react"
import {
  dropSuppressed,
  type SuppressedLogins,
} from "@/hooks/useSuppressedLogins"

// Auto-sync on open: append team members lacking a CSV row (fire once per drift
// episode, per classroom; re-arm when the drift clears). Gated on migrate having
// settled for this classroom so the two roster writers run in sequence, not a
// race. dropSuppressed skips any csv-missing member the teacher just unenrolled
// whose best-effort team-drop failed — otherwise auto-sync would re-append the
// student it just removed. (suppressedLogins is read in the effect, not during
// render; the sync re-derives the authoritative set server-side.)
//
// Keyed by classroom (not a boolean): the component instance is reused across a
// $classroom param switch, so a boolean set true for a drifting classroom A
// would wrongly skip a drifting classroom B navigated to directly (no
// intervening zero-drift render to reset it).
//
// The caller owns `runSync` (and its toasts, which skip on unmount); this hook
// only decides WHEN to fire it. `syncPending` is threaded so a fire can't stack
// on an in-flight sync.
export function useRosterAutoSync(params: {
  classroom: string
  ready: boolean
  migrateSettledFor: string | null
  csvMissingLogins: string[]
  backfillNeededLogins: string[]
  suppressedLogins: SuppressedLogins
  syncPending: boolean
  runSync: () => void
}): void {
  const {
    classroom,
    ready,
    migrateSettledFor,
    csvMissingLogins,
    backfillNeededLogins,
    suppressedLogins,
    syncPending,
    runSync,
  } = params

  const autoSyncedForRef = useRef<string | null>(null)
  const csvMissingKey = csvMissingLogins.join(",")
  const backfillNeededKey = backfillNeededLogins.join(",")
  useEffect(() => {
    if (!ready) return
    // Wait for the migrate pass to settle first (converges the legacy roster
    // name onto roster.csv) so sync's write can't race migrate's on the ref.
    if (migrateSettledFor !== classroom) return
    // Sync when there's drift to fix: a team member with no CSV row (missing),
    // OR an existing CSV row that's stale against the team (blank github_id or a
    // wrong role — the login-only row case). Without the backfill term a
    // login-only row would never converge, since it isn't "missing". BOTH terms
    // drop suppressed (just-unenrolled) logins so a stale row lingering during
    // the eventual-consistency window can't re-fire a resurrecting sync.
    const hasMissing =
      dropSuppressed(csvMissingLogins, suppressedLogins).length > 0
    const hasBackfill =
      dropSuppressed(backfillNeededLogins, suppressedLogins).length > 0
    if (!hasMissing && !hasBackfill) {
      if (autoSyncedForRef.current === classroom)
        autoSyncedForRef.current = null
      return
    }
    if (autoSyncedForRef.current === classroom || syncPending) return
    autoSyncedForRef.current = classroom
    runSync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csvMissingKey, backfillNeededKey, ready, migrateSettledFor, classroom])
}
