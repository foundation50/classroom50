import { useEffect, useRef } from "react"

import useInvalidateAfterCollect from "@/hooks/useInvalidateAfterCollect"
import useTriggerScoreCollection, {
  type CollectScoresNames,
} from "@/hooks/useTriggerScoreCollection"

type Args = {
  org: string | undefined
  classroom: string | undefined
  assignment: string | undefined
  // Display names for the banner label and the run title on GitHub.
  names: CollectScoresNames
  // Whether the viewer may dispatch the workflow (config-repo write). False
  // turns Refresh into the same re-reads without the dispatch.
  canDispatch: boolean
  // The reads a refresh re-runs beside the collect. Each overlay refetch is
  // already gated by its capability: pass undefined for one that does not run
  // on this assignment.
  refetchScores: () => unknown
  refetchOrgRepos: () => unknown
  refetchLive?: () => unknown
  refetchDetected?: () => unknown
  // The read-only Refresh's re-reads are in flight (its re-entrancy latch; a
  // dispatching viewer's latch is the collect itself).
  refreshing: boolean
}

// The submissions page's collect wiring in one place: the per-assignment
// dispatch, the post-run invalidation, the once-per-run overlay refresh, and
// the toolbar's Refresh / Collect now handler.
export function useCollectController({
  org,
  classroom,
  assignment,
  names,
  canDispatch,
  refetchScores,
  refetchOrgRepos,
  refetchLive,
  refetchDetected,
  refreshing,
}: Args) {
  // Scope the manual collect to this assignment: the workflow serializes runs
  // per scope and the Python side collects only the matching slug, so "Collect
  // now" here doesn't rebuild every classroom's gradebook.
  const collectScores = useTriggerScoreCollection(
    org,
    classroom && assignment ? { classroom, assignment } : undefined,
    names,
  )
  const collecting = collectScores.inFlight

  // Refresh scores + last-run timestamp + org repo list once a manual collection
  // finishes (or this client times out on the poll), so the table and the
  // freshness line re-derive: the collect just consumed the pushes latestPush
  // was flagging, and for a non-owner it also granted read on repos that were
  // invisible before, which flips their rows from "not accepted" to accepted
  // without a reload. Invalidation reaches the roster-scoped repo probe through
  // its orgRepos-prefixed key; the probe honors it rather than serving a
  // pre-collect listing from cache.
  useInvalidateAfterCollect(org ?? "", classroom ?? "", collectScores.phase)

  // The overlays read the repos directly and are outside that invalidation set.
  // Re-run them too: for a non-owner, a repo the collect just granted read on
  // 404'd into "not submitted" a moment ago, exactly like the manual button.
  // Fires once per completed RUN (keyed on its id), not on every render while
  // the phase reads "completed": a refetch re-renders the page, and re-firing
  // on each render looped the fan-out against the API until a reload.
  const overlayRefreshedForRun = useRef<number | null>(null)
  useEffect(() => {
    if (collectScores.phase !== "completed") return
    const runId = collectScores.run?.id ?? -1
    if (overlayRefreshedForRun.current === runId) return
    overlayRefreshedForRun.current = runId
    refetchLive?.()
    refetchDetected?.()
  }, [collectScores.phase, collectScores.run?.id, refetchLive, refetchDetected])

  // Collect now = re-collect (rebuild scores.json), for a viewer who can
  // dispatch it. A TA gets Refresh: the same re-reads without the dispatch, so
  // a collect a teacher ran elsewhere lands without a reload. Re-read the org
  // repo list too so the staleness line re-derives against the newest pushes
  // (latestPush would otherwise stay frozen at page load), and re-run the
  // overlays so presence refreshes alongside. Button's `loading` already
  // swallows the click; the checks here are the re-entrancy latch behind it.
  const refresh = () => {
    if (collecting) return
    if (!canDispatch && refreshing) return
    if (canDispatch) {
      collectScores.collect()
    } else {
      void refetchScores()
    }
    refetchOrgRepos()
    refetchLive?.()
    refetchDetected?.()
  }

  return { collectScores, collecting, refresh }
}
