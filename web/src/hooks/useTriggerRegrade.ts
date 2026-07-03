import { useMutation, useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useRegradeCoordinator } from "@/context/regrade/RegradeCoordinator"
import { triggerRegrade } from "./github/mutations"
import { getRegradeRunAfterId, githubKeys } from "./github/queries"
import type { GitHubWorkflowRun } from "./github/types"

export type RegradePhase =
  "idle" | "dispatching" | "running" | "completed" | "failed" | "timeout"

// Give up polling after this long so the UI doesn't spin forever on a run that
// never registers or hangs. The dispatch itself is quick; this is generous.
const POLL_TIMEOUT_MS = 5 * 60 * 1000
const POLL_INTERVAL_MS = 4000
const POLL_BACKOFF_AFTER_MS = 45 * 1000
const POLL_BACKOFF_INTERVAL_MS = 12000

const isRunFinished = (run: GitHubWorkflowRun | null | undefined) =>
  Boolean(run && (run.status === "completed" || run.conclusion !== null))

// The in-flight dispatch we're tracking. `sinceRunId` records the newest
// regrade dispatch run before our POST (null = none); our run is the oldest
// dispatch run with a larger id. `startedAt` anchors the timeout across remounts.
type DispatchState = { sinceRunId: number | null; startedAt: number }

// A regrade target: the whole assignment, or a single repo owner. The storage
// key and the run-tracking query key are scoped to this so two assignments (or
// two students) track independently.
export type RegradeTarget = {
  org: string | undefined
  classroom: string | undefined
  assignment: string | undefined
  owner?: string
}

const targetKey = (t: RegradeTarget) =>
  `${t.org ?? ""}/${t.classroom ?? ""}/${t.assignment ?? ""}/${t.owner ?? "*"}`

const storageKey = (t: RegradeTarget) => `cl50:regrade:${targetKey(t)}`

const isComplete = (
  t: RegradeTarget,
): t is RegradeTarget & {
  org: string
  classroom: string
  assignment: string
} => Boolean(t.org && t.classroom && t.assignment)

const loadDispatch = (t: RegradeTarget): DispatchState | null => {
  if (!isComplete(t)) return null
  try {
    const raw = sessionStorage.getItem(storageKey(t))
    if (!raw) return null
    const parsed = JSON.parse(raw) as DispatchState
    if (Date.now() - parsed.startedAt > POLL_TIMEOUT_MS) {
      sessionStorage.removeItem(storageKey(t))
      return null
    }
    return parsed
  } catch {
    return null
  }
}

const saveDispatch = (t: RegradeTarget, state: DispatchState | null) => {
  if (!isComplete(t)) return
  try {
    if (state) sessionStorage.setItem(storageKey(t), JSON.stringify(state))
    else sessionStorage.removeItem(storageKey(t))
  } catch {
    // Best-effort persistence; tracking still works within this mount.
  }
}

/**
 * Triggers the regrade.yaml workflow for an assignment (or a single student
 * when `owner` is set) and tracks the resulting dispatch run. Mirrors
 * useTriggerScoreCollection's dispatch/poll/persist pattern: snapshot the
 * newest dispatch run before the POST and poll for the oldest run with a larger
 * id, binding the poll to our own run independent of clocks and concurrent
 * dispatches. State is scoped to the (classroom, assignment, owner) target and
 * persisted to sessionStorage so a remount re-attaches; `phase` latches at
 * completed/failed/timeout until the next dispatch.
 *
 * The tracked run only kicks off grading (re-running each repo's autograde
 * workflow) — grading itself runs asynchronously after — so a "completed" phase
 * means grading was started, not that scores are ready. Callers surface that and
 * refresh via the existing collect-scores path.
 */
const useTriggerRegrade = (target: RegradeTarget) => {
  const client = useGitHubClient()
  const coordinator = useRegradeCoordinator()
  const [dispatch, setDispatch] = useState<DispatchState | null>(() =>
    loadDispatch(target),
  )
  const [timedOut, setTimedOut] = useState(false)
  // Re-derive tracking when the target changes (navigating between assignments
  // or toggling the per-row owner) during render.
  const key = targetKey(target)
  const [trackedKey, setTrackedKey] = useState(key)
  if (key !== trackedKey) {
    setTrackedKey(key)
    setDispatch(loadDispatch(target))
    setTimedOut(false)
  }

  const mutation = useMutation({
    mutationFn: () =>
      triggerRegrade(client, {
        org: target.org,
        classroom: target.classroom,
        assignment: target.assignment,
        owner: target.owner,
      }),
    onSuccess: (result) => {
      setTimedOut(false)
      const next: DispatchState = {
        sinceRunId: result.sinceRunId,
        startedAt: Date.now(),
      }
      saveDispatch(target, next)
      setDispatch(next)
    },
  })

  const runQuery = useQuery({
    queryKey: githubKeys.regradeRun(
      target.org ?? "",
      target.classroom ?? "",
      target.assignment ?? "",
      target.owner ?? null,
      dispatch?.sinceRunId ?? null,
    ),
    queryFn: ({ signal }) =>
      getRegradeRunAfterId(
        client,
        target.org ?? "",
        dispatch?.sinceRunId ?? null,
        signal,
      ),
    enabled: Boolean(isComplete(target) && dispatch && !timedOut),
    refetchInterval: (query) => {
      if (isRunFinished(query.state.data)) return false
      const elapsed = Date.now() - (dispatch?.startedAt ?? Date.now())
      return elapsed >= POLL_BACKOFF_AFTER_MS
        ? POLL_BACKOFF_INTERVAL_MS
        : POLL_INTERVAL_MS
    },
    retry: false,
    staleTime: 0,
    gcTime: 0,
  })

  const run = runQuery.data
  const runCompleted = Boolean(dispatch) && isRunFinished(run)

  // Clear persisted state once the run terminates so a remount doesn't re-attach
  // to a finished run; `phase` stays latched because `dispatch` is only reset on
  // a target change or a new dispatch.
  useEffect(() => {
    if (runCompleted) saveDispatch(target, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runCompleted, key])

  // Time out the wait, anchored to the dispatch time so a remount doesn't grant
  // a fresh window (a past deadline fires a 0ms timer rather than setting state
  // during render).
  useEffect(() => {
    if (!dispatch || runCompleted || timedOut) return
    const remaining = Math.max(
      0,
      dispatch.startedAt + POLL_TIMEOUT_MS - Date.now(),
    )
    const id = window.setTimeout(() => {
      setTimedOut(true)
      saveDispatch(target, null)
    }, remaining)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, runCompleted, timedOut, key])

  let phase: RegradePhase = "idle"
  if (mutation.isPending) phase = "dispatching"
  else if (mutation.isError) phase = "failed"
  else if (runCompleted)
    phase = run?.conclusion === "success" ? "completed" : "failed"
  else if (timedOut) phase = "timeout"
  else if (dispatch) phase = "running"

  // Publish this tracker's in-flight state to the page coordinator so the
  // page-level "Regrade all" hook, every per-row tracker, and "Collect now"
  // share one mutual-exclusion signal (and so a new dispatch can be blocked
  // while any regrade is already running). Unregister on unmount/target change.
  const inFlight = phase === "dispatching" || phase === "running"
  const { setInFlight } = coordinator
  useEffect(() => {
    setInFlight(key, inFlight)
    return () => setInFlight(key, false)
  }, [setInFlight, key, inFlight])

  return {
    // Refuse to start a second regrade while any regrade for this assignment
    // is in flight: trackers poll the same regrade.yaml run list and bind by
    // monotonic id, which assumes one outstanding dispatch at a time.
    regrade: () => {
      if (inFlight || !coordinator.canDispatch()) return
      mutation.mutate()
    },
    phase,
    run,
    error: mutation.error ?? runQuery.error,
    // True while ANY regrade (this one, another row, or "Regrade all") is in
    // flight — callers use it to disable collect/regrade controls page-wide.
    anyRegrading: coordinator.anyInFlight,
  }
}

export default useTriggerRegrade
