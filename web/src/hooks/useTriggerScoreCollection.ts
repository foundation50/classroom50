import { useMutation, useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useEffect, useState } from "react"
import { triggerScoreCollection } from "./github/mutations"
import { getCollectScoresRunAfterId, githubKeys } from "./github/queries"
import type { GitHubWorkflowRun } from "./github/types"

export type CollectScoresPhase =
  "idle" | "dispatching" | "running" | "completed" | "failed" | "timeout"

// Give up polling after this long so the UI doesn't spin forever on a run that
// never registers or hangs.
const POLL_TIMEOUT_MS = 10 * 60 * 1000
// Poll fast at first, then back off so a long run doesn't hammer the runs API.
const POLL_INTERVAL_MS = 5000
const POLL_BACKOFF_AFTER_MS = 60 * 1000
const POLL_BACKOFF_INTERVAL_MS = 15000

// Terminal once GitHub reports a conclusion, even before `status` flips to
// "completed".
const isRunFinished = (run: GitHubWorkflowRun | null | undefined) =>
  Boolean(run && (run.status === "completed" || run.conclusion !== null))

// The in-flight dispatch we're tracking. The dispatch API returns no run id, so
// `sinceRunId` records the newest dispatch run before our POST (null = none);
// our run is the oldest dispatch run with a larger id. `startedAt` anchors the
// timeout so it survives a remount.
type DispatchState = { sinceRunId: number | null; startedAt: number }

const storageKey = (org: string) => `cl50:collect-scores:${org}`

// Persist across unmount so navigating away and back re-attaches to the running
// dispatch instead of re-enabling "Collect now" and inviting a duplicate.
// sessionStorage (tab-scoped) matches the "collection started this session"
// lifetime.
const loadDispatch = (org: string | undefined): DispatchState | null => {
  if (!org) return null
  try {
    const raw = sessionStorage.getItem(storageKey(org))
    if (!raw) return null
    const parsed = JSON.parse(raw) as DispatchState
    // Drop a stale entry whose timeout window has already elapsed.
    if (Date.now() - parsed.startedAt > POLL_TIMEOUT_MS) {
      sessionStorage.removeItem(storageKey(org))
      return null
    }
    return parsed
  } catch {
    return null
  }
}

const saveDispatch = (org: string | undefined, state: DispatchState | null) => {
  if (!org) return
  try {
    if (state) sessionStorage.setItem(storageKey(org), JSON.stringify(state))
    else sessionStorage.removeItem(storageKey(org))
  } catch {
    // Best-effort persistence; tracking still works within this mount.
  }
}

/**
 * Triggers the collect-scores workflow and tracks the resulting run. The
 * dispatch API returns no run id, so we snapshot the newest dispatch run before
 * the POST and poll for the oldest run with a larger id — binding the poll to
 * our own run, independent of clocks and concurrent dispatches. Persisted to
 * sessionStorage so a remount re-attaches; `phase` latches at
 * completed/failed/timeout until the next dispatch.
 */
const useTriggerScoreCollection = (org: string | undefined) => {
  const client = useGitHubClient()
  const [dispatch, setDispatch] = useState<DispatchState | null>(() =>
    loadDispatch(org),
  )
  const [timedOut, setTimedOut] = useState(false)
  // Reset tracking when `org` changes by re-deriving from storage during render
  // (the React-idiomatic alternative to a setState-in-effect).
  const [trackedOrg, setTrackedOrg] = useState(org)
  if (org !== trackedOrg) {
    setTrackedOrg(org)
    setDispatch(loadDispatch(org))
    setTimedOut(false)
  }

  const mutation = useMutation({
    // Org-wide collection, matching the "Last collected" timestamp. Pass a
    // classroom slug as the third arg to scope it: the workflow already accepts
    // a `classroom` dispatch input.
    mutationFn: () => triggerScoreCollection(client, org ?? ""),
    onSuccess: (result) => {
      setTimedOut(false)
      const next: DispatchState = {
        sinceRunId: result.sinceRunId,
        startedAt: Date.now(),
      }
      saveDispatch(org, next)
      setDispatch(next)
    },
  })

  const runQuery = useQuery({
    queryKey: githubKeys.collectScoresRun(
      org ?? "",
      dispatch?.sinceRunId ?? null,
    ),
    queryFn: ({ signal }) =>
      getCollectScoresRunAfterId(
        client,
        org ?? "",
        dispatch?.sinceRunId ?? null,
        signal,
      ),
    enabled: Boolean(org && dispatch && !timedOut),
    refetchInterval: (query) => {
      if (isRunFinished(query.state.data)) return false
      // Back off once the run has been pending a while. Anchored to the
      // dispatch's wall-clock start (survives remounts) rather than a poll count.
      const elapsed = Date.now() - (dispatch?.startedAt ?? Date.now())
      return elapsed >= POLL_BACKOFF_AFTER_MS
        ? POLL_BACKOFF_INTERVAL_MS
        : POLL_INTERVAL_MS
    },
    // No internal retry; refetchInterval already polls.
    retry: false,
    staleTime: 0,
    gcTime: 0,
  })

  const run = runQuery.data
  const runCompleted = Boolean(dispatch) && isRunFinished(run)

  // Clear persisted state once the run terminates so a remount doesn't re-attach
  // to a finished run; `phase` stays latched because `dispatch` is only reset on
  // org change or a new dispatch.
  useEffect(() => {
    if (runCompleted) saveDispatch(org, null)
  }, [runCompleted, org])

  // Time out the wait, flipping a flag that both stops the query and latches
  // `phase` to "timeout". The deadline is anchored to the dispatch time so a
  // remount doesn't grant a fresh window (a past deadline fires a 0ms timer
  // rather than setting state during render).
  useEffect(() => {
    if (!dispatch || runCompleted || timedOut) return
    const remaining = Math.max(
      0,
      dispatch.startedAt + POLL_TIMEOUT_MS - Date.now(),
    )
    const id = window.setTimeout(() => {
      setTimedOut(true)
      saveDispatch(org, null)
    }, remaining)
    return () => window.clearTimeout(id)
  }, [dispatch, runCompleted, timedOut, org])

  let phase: CollectScoresPhase = "idle"
  if (mutation.isPending) phase = "dispatching"
  else if (mutation.isError) phase = "failed"
  else if (runCompleted)
    phase = run?.conclusion === "success" ? "completed" : "failed"
  else if (timedOut) phase = "timeout"
  // Transient poll errors self-heal via refetchInterval; stay "running" until
  // the run finishes or the timeout fires.
  else if (dispatch) phase = "running"

  return {
    collect: () => mutation.mutate(),
    phase,
    run,
    error: mutation.error ?? runQuery.error,
  }
}

export default useTriggerScoreCollection
