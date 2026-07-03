import { useMutation, useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"

import type { GitHubWorkflowRun } from "./github/types"

// The lifecycle phase of a tracked workflow_dispatch operation. Shared by every
// dispatch-and-track hook (collect scores, regrade).
export type OperationPhase =
  "idle" | "dispatching" | "running" | "completed" | "failed" | "timeout"

// The dispatch API returns no run id, so `sinceRunId` records the newest
// matching dispatch run before our POST (null = none); the run we triggered is
// the oldest run with a larger id. `startedAt` anchors the timeout across
// remounts. Persisted to sessionStorage so navigating away and back re-attaches
// to the in-flight dispatch instead of re-enabling the trigger.
export type DispatchState = { sinceRunId: number | null; startedAt: number }

// Terminal once GitHub reports a conclusion, even before `status` flips to
// "completed".
const isRunFinished = (run: GitHubWorkflowRun | null | undefined) =>
  Boolean(run && (run.status === "completed" || run.conclusion !== null))

export type GitHubOperationConfig = {
  // Null disables tracking (e.g. an incomplete regrade target): no persistence,
  // no polling, phase stays "idle".
  storageKey: string | null
  // React Query key builder for the run-tracking poll, given the active
  // dispatch's baseline. Keying by sinceRunId scopes each dispatch to its own
  // cache entry.
  queryKey: (sinceRunId: number | null) => readonly unknown[]
  // Re-derive tracking from storage when this changes (org, or a regrade
  // target key). Distinct operations must use distinct reset keys.
  resetKey: string
  // Dispatches the workflow and returns the pre-dispatch run-id baseline.
  // `startedAt` is stamped by this primitive on success.
  dispatch: () => Promise<{ sinceRunId: number | null }>
  // Finds the run our dispatch produced (oldest run newer than `sinceRunId`).
  findRun: (
    sinceRunId: number | null,
    signal?: AbortSignal,
  ) => Promise<GitHubWorkflowRun | null>
  // Timing knobs (defaults are the collect-scores values).
  timeoutMs?: number
  intervalMs?: number
  backoffAfterMs?: number
  backoffIntervalMs?: number
  // Called after a successful dispatch with the resulting baseline — used to
  // register the operation with the global activity banner. Kept as a callback
  // so this primitive stays banner-agnostic.
  onDispatched?: (state: DispatchState) => void
}

const DEFAULTS = {
  timeoutMs: 10 * 60 * 1000,
  intervalMs: 5000,
  backoffAfterMs: 60 * 1000,
  backoffIntervalMs: 15000,
}

const loadDispatch = (
  storageKey: string | null,
  timeoutMs: number,
): DispatchState | null => {
  if (!storageKey) return null
  try {
    const raw = sessionStorage.getItem(storageKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DispatchState
    // Drop a stale entry whose timeout window has already elapsed.
    if (Date.now() - parsed.startedAt > timeoutMs) {
      sessionStorage.removeItem(storageKey)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

const saveDispatch = (storageKey: string | null, state: DispatchState | null) => {
  if (!storageKey) return
  try {
    if (state) sessionStorage.setItem(storageKey, JSON.stringify(state))
    else sessionStorage.removeItem(storageKey)
  } catch {
    // Best-effort persistence; tracking still works within this mount.
  }
}

/**
 * Shared dispatch-and-track machine for a classroom50 workflow_dispatch
 * operation. Snapshots the newest matching dispatch run before the POST and
 * polls for the oldest run with a larger id — binding the poll to our own run,
 * independent of clocks and concurrent dispatches. State is persisted to
 * sessionStorage (per `storageKey`) so a remount re-attaches; `phase` latches at
 * completed/failed/timeout until the next dispatch or a `resetKey` change.
 *
 * Callers (useTriggerScoreCollection, useTriggerRegrade) supply the workflow
 * specifics (dispatch fn, run finder, keys, timing) and layer their own concerns
 * (banner registration via onDispatched, the regrade coordinator) on top.
 */
export function useGitHubOperation(config: GitHubOperationConfig) {
  const timeoutMs = config.timeoutMs ?? DEFAULTS.timeoutMs
  const intervalMs = config.intervalMs ?? DEFAULTS.intervalMs
  const backoffAfterMs = config.backoffAfterMs ?? DEFAULTS.backoffAfterMs
  const backoffIntervalMs = config.backoffIntervalMs ?? DEFAULTS.backoffIntervalMs

  const [dispatch, setDispatch] = useState<DispatchState | null>(() =>
    loadDispatch(config.storageKey, timeoutMs),
  )
  const [timedOut, setTimedOut] = useState(false)

  // Re-derive tracking when the reset key changes (org / target) during render —
  // the React-idiomatic alternative to a setState-in-effect.
  const [trackedKey, setTrackedKey] = useState(config.resetKey)
  if (config.resetKey !== trackedKey) {
    setTrackedKey(config.resetKey)
    setDispatch(loadDispatch(config.storageKey, timeoutMs))
    setTimedOut(false)
  }

  const mutation = useMutation({
    mutationFn: () => config.dispatch(),
    onSuccess: (result) => {
      setTimedOut(false)
      const state: DispatchState = {
        sinceRunId: result.sinceRunId,
        startedAt: Date.now(),
      }
      saveDispatch(config.storageKey, state)
      setDispatch(state)
      config.onDispatched?.(state)
    },
  })

  const runQuery = useQuery({
    // Scope the cache entry to the active dispatch's baseline so a new dispatch
    // gets a fresh entry rather than reusing a prior run's cached result.
    queryKey: config.queryKey(dispatch?.sinceRunId ?? null),
    queryFn: ({ signal }) =>
      config.findRun(dispatch?.sinceRunId ?? null, signal),
    enabled: Boolean(config.storageKey && dispatch && !timedOut),
    refetchInterval: (query) => {
      if (isRunFinished(query.state.data)) return false
      // Back off once the run has been pending a while. Anchored to the
      // dispatch's wall-clock start (survives remounts) rather than a poll count.
      const elapsed = Date.now() - (dispatch?.startedAt ?? Date.now())
      return elapsed >= backoffAfterMs ? backoffIntervalMs : intervalMs
    },
    retry: false,
    staleTime: 0,
    gcTime: 0,
  })

  const run = runQuery.data
  const runCompleted = Boolean(dispatch) && isRunFinished(run)

  // Clear persisted state once the run terminates so a remount doesn't re-attach
  // to a finished run; `phase` stays latched because `dispatch` is only reset on
  // a reset-key change or a new dispatch.
  useEffect(() => {
    if (runCompleted) saveDispatch(config.storageKey, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runCompleted, trackedKey])

  // Time out the wait, flipping a flag that both stops the query and latches
  // `phase` to "timeout". The deadline is anchored to the dispatch time so a
  // remount doesn't grant a fresh window (a past deadline fires a 0ms timer
  // rather than setting state during render).
  useEffect(() => {
    if (!dispatch || runCompleted || timedOut) return
    const remaining = Math.max(0, dispatch.startedAt + timeoutMs - Date.now())
    const id = window.setTimeout(() => {
      setTimedOut(true)
      saveDispatch(config.storageKey, null)
    }, remaining)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, runCompleted, timedOut, trackedKey])

  let phase: OperationPhase = "idle"
  if (mutation.isPending) phase = "dispatching"
  else if (mutation.isError) phase = "failed"
  else if (runCompleted)
    phase = run?.conclusion === "success" ? "completed" : "failed"
  else if (timedOut) phase = "timeout"
  // Transient poll errors self-heal via refetchInterval; stay "running" until
  // the run finishes or the timeout fires.
  else if (dispatch) phase = "running"

  return {
    trigger: () => mutation.mutate(),
    phase,
    run,
    error: mutation.error ?? runQuery.error,
  }
}
