import { useMutation, useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"

import type { GitHubWorkflowRun } from "@/github-core/types"

// Lifecycle phase of a tracked workflow_dispatch operation, shared by every
// dispatch-and-track hook (collect scores, regrade).
export type OperationPhase =
  "idle" | "dispatching" | "running" | "completed" | "failed" | "timeout"

// Which side failed when `phase` is "failed": the dispatch POST was rejected
// ("dispatch"), or the run we tracked reached a non-success conclusion ("run").
// Every dispatch is registered with the Actions banner, so a caller that would
// otherwise report both needs the split to avoid announcing a run failure the
// banner already shows.
export type OperationFailure = "dispatch" | "run"

// The dispatch API returns no run id, so `sinceRunId` records the newest
// matching run before our POST (null = none); ours is the oldest run past it.
// `startedAt` anchors the timeout across remounts. Persisted to sessionStorage
// so a remount re-attaches instead of re-enabling the trigger.
export type DispatchState = { sinceRunId: number | null; startedAt: number }

// Terminal once GitHub reports a conclusion, even before status flips to completed.
const isRunFinished = (run: GitHubWorkflowRun | null | undefined) =>
  Boolean(run && (run.status === "completed" || run.conclusion !== null))

// Statuses GitHub reports before any job starts — the run exists on record, but
// the workflow's own `timeout-minutes` is not counting yet.
const QUEUED_STATUSES: ReadonlySet<GitHubWorkflowRun["status"]> = new Set([
  "queued",
  "waiting",
  "requested",
  "pending",
])

// When our run's job clock started, or null while it is still queued (or not
// discovered yet). `run_started_at` is the authoritative stamp; a run past the
// queue that omits it has started regardless, so fall back to its creation time.
const runStartedMs = (run: GitHubWorkflowRun | null | undefined) => {
  if (!run || QUEUED_STATUSES.has(run.status)) return null
  const parsed = Date.parse(run.run_started_at ?? run.created_at)
  return Number.isNaN(parsed) ? null : parsed
}

export type GitHubOperationConfig = {
  // Null disables tracking (no persistence/polling, phase stays "idle").
  storageKey: string | null
  // Query-key builder keyed by the dispatch baseline, scoping each dispatch's cache.
  queryKey: (sinceRunId: number | null) => readonly unknown[]
  // Re-derive tracking from storage when this changes (org / regrade target).
  resetKey: string
  // Dispatches the workflow, returning the pre-dispatch baseline.
  dispatch: () => Promise<{ sinceRunId: number | null }>
  // Finds the run our dispatch produced (oldest run past `sinceRunId`).
  findRun: (
    sinceRunId: number | null,
    signal?: AbortSignal,
  ) => Promise<GitHubWorkflowRun | null>
  // Timing knobs (defaults are the collect-scores values).
  // `timeoutMs` bounds execution once our run starts; `queueTimeoutMs` bounds
  // the wait for it to leave the Actions queue and defaults to the same value.
  timeoutMs?: number
  queueTimeoutMs?: number
  intervalMs?: number
  backoffAfterMs?: number
  backoffIntervalMs?: number
  // Called after a successful dispatch — used to register with the banner. Kept
  // as a callback so this primitive stays banner-agnostic.
  onDispatched?: (state: DispatchState) => void
}

const DEFAULTS = {
  timeoutMs: 10 * 60 * 1000,
  intervalMs: 5000,
  backoffAfterMs: 60 * 1000,
  backoffIntervalMs: 15000,
}

// `maxWaitMs` is the whole wait (queue + execution), so a remount midway
// through a long queue wait re-attaches instead of discarding a live dispatch.
const loadDispatch = (
  storageKey: string | null,
  maxWaitMs: number,
): DispatchState | null => {
  if (!storageKey) return null
  try {
    const raw = sessionStorage.getItem(storageKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DispatchState
    // Drop a stale entry past its timeout window.
    if (Date.now() - parsed.startedAt > maxWaitMs) {
      sessionStorage.removeItem(storageKey)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

const saveDispatch = (
  storageKey: string | null,
  state: DispatchState | null,
) => {
  if (!storageKey) return
  try {
    if (state) sessionStorage.setItem(storageKey, JSON.stringify(state))
    else sessionStorage.removeItem(storageKey)
  } catch {
    // Best-effort persistence; tracking still works within this mount.
  }
}

/**
 * Shared dispatch-and-track machine for a classroom50 workflow_dispatch op.
 * Snapshots the newest matching run before the POST and polls for the oldest run
 * past it — binding to our own run, independent of clocks and concurrent
 * dispatches. State persists to sessionStorage (per `storageKey`) so a remount
 * re-attaches; `phase` latches at completed/failed/timeout until the next
 * dispatch or a `resetKey` change. Callers supply the workflow specifics.
 */
export function useGitHubOperation(config: GitHubOperationConfig) {
  const timeoutMs = config.timeoutMs ?? DEFAULTS.timeoutMs
  const queueTimeoutMs = config.queueTimeoutMs ?? timeoutMs
  const maxWaitMs = queueTimeoutMs + timeoutMs
  const intervalMs = config.intervalMs ?? DEFAULTS.intervalMs
  const backoffAfterMs = config.backoffAfterMs ?? DEFAULTS.backoffAfterMs
  const backoffIntervalMs =
    config.backoffIntervalMs ?? DEFAULTS.backoffIntervalMs

  const [dispatch, setDispatch] = useState<DispatchState | null>(() =>
    loadDispatch(config.storageKey, maxWaitMs),
  )
  const [timedOut, setTimedOut] = useState(false)

  // Re-derive tracking when the reset key changes (org / target), during render
  // — the idiomatic alternative to setState-in-effect.
  const [trackedKey, setTrackedKey] = useState(config.resetKey)
  if (config.resetKey !== trackedKey) {
    setTrackedKey(config.resetKey)
    setDispatch(loadDispatch(config.storageKey, maxWaitMs))
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
    // Key by the active baseline so a new dispatch gets a fresh cache entry.
    queryKey: config.queryKey(dispatch?.sinceRunId ?? null),
    queryFn: ({ signal }) =>
      config.findRun(dispatch?.sinceRunId ?? null, signal),
    enabled: Boolean(config.storageKey && dispatch && !timedOut),
    refetchInterval: (query) => {
      if (isRunFinished(query.state.data)) return false
      // Back off once pending a while, anchored to the dispatch start (survives
      // remounts) rather than a poll count.
      const elapsed = Date.now() - (dispatch?.startedAt ?? Date.now())
      return elapsed >= backoffAfterMs ? backoffIntervalMs : intervalMs
    },
    retry: false,
    staleTime: 0,
    gcTime: 0,
  })

  const run = runQuery.data
  const runCompleted = Boolean(dispatch) && isRunFinished(run)

  // Deadline for the wait. GitHub's `timeout-minutes` caps execution only, so a
  // run parked behind a busy concurrency group can sit queued long before its
  // job clock starts; anchoring the whole window to the dispatch expired a
  // healthy run, which dropped the tracked dispatch and re-enabled the trigger
  // for exactly the duplicate this tracking prevents. Wait the queue out on
  // `queueTimeoutMs`, then give execution `timeoutMs` from the run's own start.
  // The two never compound past `maxWaitMs` (which also bounds a `run_started_at`
  // skewed into the future), so the wait always ends and the banner stays the
  // long-running surface.
  const startedMs = runStartedMs(run)
  const deadline = dispatch
    ? Math.min(
        startedMs === null
          ? dispatch.startedAt + queueTimeoutMs
          : Math.max(startedMs, dispatch.startedAt) + timeoutMs,
        dispatch.startedAt + maxWaitMs,
      )
    : 0

  // Clear persisted state once the run terminates so a remount doesn't re-attach;
  // `phase` stays latched (dispatch resets only on a reset-key change or new
  // dispatch).
  useEffect(() => {
    if (runCompleted) saveDispatch(config.storageKey, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runCompleted, trackedKey])

  // Time out the wait: flip a flag that stops the query and latches phase to
  // "timeout". The deadline is derived from stamps, not from mount time, so a
  // remount doesn't grant a fresh window (a past deadline fires a 0ms timer,
  // not a render-time setState) and the timer re-arms when the run starts.
  useEffect(() => {
    if (!dispatch || runCompleted || timedOut) return
    const remaining = Math.max(0, deadline - Date.now())
    const id = window.setTimeout(() => {
      setTimedOut(true)
      saveDispatch(config.storageKey, null)
    }, remaining)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, runCompleted, timedOut, trackedKey, deadline])

  let phase: OperationPhase = "idle"
  let failure: OperationFailure | null = null
  if (mutation.isPending) phase = "dispatching"
  else if (mutation.isError) {
    phase = "failed"
    failure = "dispatch"
  } else if (runCompleted) {
    if (run?.conclusion === "success") phase = "completed"
    else {
      phase = "failed"
      failure = "run"
    }
  } else if (timedOut) phase = "timeout"
  // Transient poll errors self-heal via refetchInterval; stay "running".
  else if (dispatch) phase = "running"

  return {
    trigger: () => mutation.mutate(),
    phase,
    failure,
    run,
    error: mutation.error ?? runQuery.error,
  }
}
