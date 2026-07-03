import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
import {
  activityRunsKey,
  listActiveAndRecentRuns,
} from "@/hooks/github/activityRuns"
import { rerunFailedRun } from "@/hooks/github/mutations"
import type { GitHubWorkflowRun } from "@/hooks/github/types"
import { useActionActivityRegistry } from "@/context/actions/ActionActivityProvider"
import { useOptionalToast } from "@/context/notifications/NotificationProvider"
import { useActiveOrg } from "@/hooks/useActiveOrg"
import {
  isRunning,
  nowMs,
  resolveOpRun,
  runTimes,
  runUrl,
  trackerPhase,
  workflowFile,
  type TrackerPhase,
} from "@/util/actionActivity"

// Poll cadence for the activity banner. Poll fast (5s) while there is activity
// so the banner is as responsive as the per-op trackers; back off to a slower
// interval when idle so an open org page doesn't hammer the runs API. The query
// still only runs while an org route is active.
const POLL_ACTIVE_MS = 5000
const POLL_IDLE_MS = 15_000

// After a commit/dispatch is registered, keep the poll on the fast cadence for
// this window so the resulting run surfaces quickly ("Starting…").
const PENDING_GRACE_MS = 20_000

// How long a still-pending op that NEVER produced a trackable run is kept before
// being dropped as a mis-registration. Generous, because a push-triggered
// publish-pages deploy can take minutes to appear/complete — an op that has
// already bound to a run or finished is NEVER dropped by this (it persists as
// history until dismissed); only ops that never surfaced a run are cleaned up.
const PENDING_TTL_MS = 5 * 60_000

// After a retry, optimistically show the tracker as "running" for this window
// (and hold the poll fast) so the banner flips to in-progress immediately,
// before GitHub reports the re-run's status. GitHub can take several seconds to
// flip the run back to in_progress after rerun-failed-jobs.
const RETRY_OPTIMISTIC_MS = 20_000

// Map a workflow definition file to a generic label key, used to label a
// discovered run (cron collect-scores, another teacher's dispatch) that doesn't
// match any session operation.
const WORKFLOW_LABEL_KEY: Record<string, string> = {
  "publish-pages.yaml": "actionsBanner.workflow.publishPages",
  "collect-scores.yaml": "actionsBanner.workflow.collectScores",
  "regrade.yaml": "actionsBanner.workflow.regrade",
}

// One row in the banner: an action and its live state.
export type Tracker = {
  // Stable key: the session op id, or `run-<id>` for a discovered run.
  id: string
  label: string
  phase: TrackerPhase
  // Link to the run on GitHub (absent only for a still-pending session op whose
  // run hasn't surfaced yet).
  htmlUrl?: string
  // The resolved GitHub run id, when known — enables retry of a failed run.
  runId?: number
  // Failed session-op trackers can be dismissed by the teacher; discovered runs
  // and non-failed trackers cannot.
  dismissible: boolean
  // A failed run with a known runId can be retried (re-run its failed jobs).
  retriable: boolean
  // Run start time (ms epoch), for showing elapsed time. Undefined while the
  // run hasn't surfaced (pending).
  startedAtMs?: number
  // Run finish time (ms epoch) once terminal; undefined while running, which
  // the UI reads as "still ticking".
  endedAtMs?: number
}

export type ActionActivity = {
  org: string | undefined
  trackers: Tracker[]
  anyFailed: boolean
  // Dismiss a failed tracker (by its id).
  dismiss: (id: string) => void
  // Retry a failed tracker (re-run the failed jobs of its run).
  retry: (id: string) => void
  // Tracker ids with a retry currently in flight (for a spinner / disabled X).
  retrying: ReadonlySet<string>
}

// Drives the global activity banner: a single repo-wide poll advances a
// collection of per-operation trackers. Each session-registered op resolves to
// its own run (collect-score-like) and reflects that run's real status +
// conclusion; runs matching no op surface as generic "discovered" trackers.
// Terminal trackers (success AND failed) persist as run history until the
// teacher dismisses them.
export function useActionActivity(): ActionActivity {
  const { t } = useTranslation()
  const org = useActiveOrg()
  const client = useOptionalGitHubClient()
  const { operationsForOrg, lastRegisteredAt, isDismissed, dismiss, clearOp } =
    useActionActivityRegistry()
  const toast = useOptionalToast()
  const queryClient = useQueryClient()

  const registeredAt = lastRegisteredAt(org)

  // Track whether a just-registered op's run has surfaced yet, to keep the poll
  // on the fast cadence during the grace window. Ops persist in sessionStorage,
  // so on mount `registeredAt` may carry a timestamp from earlier this session;
  // `lastSeenRegisteredAt` is seeded with the mount value so only a NEWER
  // registration re-arms the fast poll.
  const lastSeenRegisteredAt = useRef(registeredAt)
  // While `nowMs() < expectingUntil` the poll stays on the fast cadence — set on
  // a new registration AND on retry, both of which expect a run to (re)appear
  // shortly. A self-expiring timestamp (rather than a boolean + clearing timer)
  // means no code path can leave the fast poll stuck on: once the window passes,
  // refetchInterval naturally backs off. Bumped via bumpExpecting() below.
  const [expectingUntil, setExpectingUntil] = useState(0)
  const bumpExpecting = useCallback(
    () => setExpectingUntil(nowMs() + PENDING_GRACE_MS),
    [],
  )

  // Retry state (declared before the query so the poll cadence can read it).
  // `retrying` tracks in-flight retry requests (spinner + double-submit guard);
  // `optimisticRunning` holds ids shown as running right after a retry so the
  // banner flips to in-progress immediately and its lifecycle GC doesn't clear
  // it while the run transitions back.
  const [retrying, setRetrying] = useState<Set<string>>(new Set())
  const [optimisticRunning, setOptimisticRunning] = useState<Set<string>>(
    new Set(),
  )
  // Wall-clock time of the last retry per op. A retry is a fresh action from the
  // teacher's point of view, so the retried tracker jumps to the front of the
  // banner (leads the collapsed header) — ordering below sorts a retried op by
  // this timestamp ahead of its original registration order.
  const [retriedAt, setRetriedAt] = useState<Record<string, number>>({})

  // Registered session ops for this org (oldest first). Read before the query
  // so the poll cadence can keep a slow poll alive while any op is still
  // outstanding (e.g. a publish-pages deploy whose run takes longer than the
  // expecting window to appear), rather than stopping the moment the runs list
  // is momentarily empty.
  const ops = operationsForOrg(org)

  const runsQuery = useQuery({
    queryKey: activityRunsKey(org ?? ""),
    queryFn: ({ signal }) => listActiveAndRecentRuns(client!, org ?? "", signal),
    enabled: Boolean(org && client),
    // Poll fast while anything is running OR a dispatch/retry is still expected
    // to surface, so the banner reacts about as quickly as the per-op trackers;
    // slow to the idle cadence once nothing is in flight but a recently-finished
    // run is still shown; and STOP entirely (return false) once there is truly
    // nothing active and nothing expected. A new dispatch/retry re-arms the poll
    // via the register()-driven invalidate + bumpExpecting, so a fully idle tab
    // doesn't burn GitHub REST budget forever (esp. combined with background
    // polling below).
    refetchInterval: (query) => {
      const runs = query.state.data ?? []
      const anyRunning = runs.some(isRunning)
      const expecting = nowMs() < expectingUntil
      if (anyRunning || expecting || optimisticRunning.size > 0) {
        return POLL_ACTIVE_MS
      }
      // Nothing in flight. Keep a slow poll only while recently-finished runs
      // are still on screen OR a registered op is still outstanding (so a run
      // that completes elsewhere, or a not-yet-surfaced deploy, still updates);
      // once there's genuinely nothing to track, stop.
      return runs.length > 0 || ops.length > 0 ? POLL_IDLE_MS : false
    },
    // Keep polling while the tab is backgrounded so a teacher watching the run
    // on github.com in another tab still sees the banner update. Combined with
    // the refetchInterval above, a truly idle tab stops (returns false), so this
    // doesn't become an unbounded background drain.
    refetchIntervalInBackground: true,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  })

  const allRuns = runsQuery.data ?? []

  // On settle of a retry, drop its in-flight flag and refetch so the banner
  // picks up the real in-flight run. On ERROR (e.g. GitHub rejects the re-run —
  // 403 not-rerunnable, or the token lacks Actions write), also clear the
  // optimistic-running flag so the tracker falls straight back to its real
  // `failed` state instead of masquerading as "running" (and hiding retry /
  // dismiss) until the safety window elapses.
  const retryMutation = useMutation({
    mutationFn: ({ runId }: { trackerId: string; runId: number }) =>
      rerunFailedRun(client!, org ?? "", runId),
    onError: (err, { trackerId }) => {
      setOptimisticRunning((prev) => {
        if (!prev.has(trackerId)) return prev
        const next = new Set(prev)
        next.delete(trackerId)
        return next
      })
      // Surface the rejection so the teacher learns the RETRY itself failed
      // (e.g. 403 not-rerunnable, token lacks Actions:write, run too old) rather
      // than silently snapping back to "failed" and re-clicking into the same
      // rejection. Keyed so repeated retries replace the toast instead of
      // stacking. Best-effort: no-op if rendered outside a NotificationProvider.
      const detail = err instanceof Error ? err.message : String(err)
      toast?.notify({
        tone: "error",
        message: t("actionsBanner.retryFailed", { detail }),
        key: `actionsBanner.retryFailed.${trackerId}`,
        durationMs: 8000,
      })
    },
    onSettled: (_data, _err, { trackerId }) => {
      setRetrying((prev) => {
        const next = new Set(prev)
        next.delete(trackerId)
        return next
      })
      if (org) {
        void queryClient.invalidateQueries({
          queryKey: activityRunsKey(org),
        })
      }
    },
  })

  // On a new registration, kick off an immediate poll and open the "expecting a
  // run" window so the pending tracker shows instantly and the poll stays fast.
  useEffect(() => {
    if (!org) return
    if (registeredAt <= lastSeenRegisteredAt.current) return
    lastSeenRegisteredAt.current = registeredAt
    bumpExpecting()
    void queryClient.invalidateQueries({
      queryKey: activityRunsKey(org),
    })
  }, [registeredAt, org, queryClient, bumpExpecting])

  // Stable op -> runId bindings, held in state (updated in an effect below).
  // Once an op resolves to a run we remember it, so clearing a sibling op (e.g.
  // a success flash elapsing) can't re-shuffle which run a still-showing op
  // points at — without this, a failed op could re-bind to a cleared sibling's
  // success run and wrongly flip to success. Reading from state keeps render
  // pure (no ref mutation during render).
  const [boundRunId, setBoundRunId] = useState<Record<string, number>>({})

  // Last observed TERMINAL phase per op (success/failed), latched so a finished
  // tracker keeps showing its outcome even after its run ages out of the polled
  // window. Read in `resolved` above; written in the effect below.
  const [latchedPhase, setLatchedPhase] = useState<
    Record<string, TrackerPhase>
  >({})

  const claimed = new Set<number>()
  const runsById = new Map(allRuns.map((r) => [r.id, r]))
  const resolved = ops.map((op) => {
    const remembered = boundRunId[op.id]
    // Once an op has bound to a run, it stays pinned to THAT run — it never
    // re-resolves. A poll that transiently omits the bound run (it scrolled out
    // of the window, or one of the 3 status pages briefly missed it) yields
    // `null` here, which reads as pending/latched — NOT a fall-through to
    // resolveOpRun, which would re-bind this op onto a sibling's still-present
    // run (wrong URL/phase/elapsed, and a wrong terminal phase could latch).
    // Claim the remembered id even when absent so a concurrent same-workflow
    // sibling can't grab it either.
    let run: GitHubWorkflowRun | null
    if (remembered !== undefined) {
      run = claimed.has(remembered) ? null : (runsById.get(remembered) ?? null)
      claimed.add(remembered)
    } else {
      run = resolveOpRun(op, allRuns, claimed)
      if (run) claimed.add(run.id)
    }
    const realPhase = trackerPhase(run)
    // A just-retried op shows "running" optimistically until the poll observes
    // the re-run genuinely in flight (or it settles again).
    let phase =
      optimisticRunning.has(op.id) && realPhase !== "running"
        ? "running"
        : realPhase
    // Latch: once an op reached a terminal state, keep showing it even if its
    // run later scrolls out of the polled completed window (which would make
    // resolveOpRun return null -> "pending"). Without this a finished (failed
    // or succeeded) tracker would silently revert to pending and then get GC'd
    // — exactly the "action disappeared while it was still failing" bug.
    const latched = latchedPhase[op.id]
    if (
      phase === "pending" &&
      (latched === "failed" || latched === "success")
    ) {
      phase = latched
    }
    return { op, run, phase, realPhase }
  })

  // Persist newly-formed bindings and drop those for ops that left the store.
  const bindingSignature = resolved
    .map(({ op, run }) => `${op.id}:${run?.id ?? ""}`)
    .join(",")
  useEffect(() => {
    setBoundRunId((prev) => {
      const next: Record<string, number> = {}
      let changed = false
      for (const { op, run } of resolved) {
        // Keep the first run an op bound to; don't overwrite with a later
        // re-resolution.
        const keep = prev[op.id] ?? run?.id
        if (keep !== undefined) next[op.id] = keep
        if (prev[op.id] !== keep) changed = true
      }
      for (const id of Object.keys(prev)) {
        if (next[id] === undefined) changed = true
      }
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindingSignature])

  // A signature of each op's current phase, used to re-run lifecycle effects
  // only when a phase actually changes.
  const phaseSignature = resolved.map((r) => `${r.op.id}:${r.phase}`).join(",")

  // Latch terminal phases so a finished tracker survives its run scrolling out
  // of the poll window. Prune entries for ops no longer in the store.
  useEffect(() => {
    setLatchedPhase((prev) => {
      const next: Record<string, TrackerPhase> = {}
      let changed = false
      for (const { op, phase } of resolved) {
        const carried = prev[op.id]
        // Keep an existing terminal latch; upgrade to terminal when observed.
        const value =
          carried === "failed" || carried === "success"
            ? carried
            : phase === "failed" || phase === "success"
              ? phase
              : undefined
        if (value !== undefined) next[op.id] = value
        if (prev[op.id] !== value) changed = true
      }
      for (const id of Object.keys(prev)) {
        if (next[id] === undefined) changed = true
      }
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseSignature])

  // Time-based lifecycle, kept entirely in an effect (render stays pure): drop a
  // pending op only when it NEVER produced a trackable run within a generous
  // window — an op that already bound to a run (boundRunId) or reached a
  // terminal state (latchedPhase) is real history and must persist until
  // dismissed, even if its run has since scrolled out of the polled window.
  // Re-arm a timer for the nearest pending deadline so clearing happens promptly.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const at = nowMs()
    const deadlines: number[] = []
    for (const { op, phase } of resolved) {
      if (phase !== "pending") continue
      // Never GC an op we've already attributed to a run or seen finish.
      if (boundRunId[op.id] !== undefined || latchedPhase[op.id] !== undefined) {
        continue
      }
      const due = op.startedAt + PENDING_TTL_MS
      if (at >= due) clearOp(op.id)
      else deadlines.push(due)
    }
    const nextDue = deadlines.sort((a, b) => a - b)[0]
    if (nextDue === undefined) return
    const id = window.setTimeout(
      () => setTick((n) => n + 1),
      Math.max(0, nextDue - at) + 50,
    )
    return () => window.clearTimeout(id)
    // Re-run when the op/phase set changes or the re-arm timer fires (tick).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseSignature, tick, clearOp])

  // Session trackers: every non-dismissed, non-cleared op. Time-based removal is
  // handled by the effect above via clearOp, so render is a pure projection of
  // the current ops + their resolved phase. The runId/URL fall back to the
  // stable binding so a transient poll that omits the run doesn't drop the
  // "View run" link mid-flight.
  const sessionTrackers: Tracker[] = resolved
    .filter(({ op }) => !isDismissed(op.id))
    .map(({ op, run, phase }) => {
      const stableRunId = run?.id ?? boundRunId[op.id]
      const times = run ? runTimes(run) : {}
      return {
        id: op.id,
        label: op.label,
        phase,
        htmlUrl:
          run?.html_url ??
          (org && stableRunId !== undefined
            ? runUrl(org, stableRunId)
            : undefined),
        runId: stableRunId,
        // Terminal ops (success or failed) persist as run history and can be
        // dismissed; a running/pending op can't.
        dismissible: phase === "success" || phase === "failed",
        retriable: phase === "failed" && stableRunId !== undefined,
        startedAtMs: times.startedAtMs,
        endedAtMs: times.endedAtMs,
      }
    })

  // Discovered trackers: runs currently in flight that match no session op
  // (cron, another teacher). Shown while running; they simply drop when they
  // finish (we don't own their success/failure lifecycle).
  const discoveredTrackers: Tracker[] = allRuns
    .filter(isRunning)
    .filter((r) => !claimed.has(r.id))
    .map((r) => {
      const file = workflowFile(r)
      const label =
        (file && WORKFLOW_LABEL_KEY[file] && t(WORKFLOW_LABEL_KEY[file])) ||
        r.name ||
        t("actionsBanner.workflow.generic")
      const times = runTimes(r)
      return {
        id: `run-${r.id}`,
        label,
        phase: "running" as TrackerPhase,
        htmlUrl: r.html_url,
        runId: r.id,
        dismissible: false,
        retriable: false,
        startedAtMs: times.startedAtMs,
        endedAtMs: times.endedAtMs,
      }
    })

  // Newest-first: session ops lead the banner, then discovered runs by
  // descending id. So trackers[0] is the leading action shown in the collapsed
  // header. Session order is normally reverse registration (most recent
  // action first), but a RETRIED op is treated as a fresh action and jumps
  // ahead of un-retried ones (most-recently-retried first) — so retrying a
  // failed action makes it the highlighted/leading tracker.
  const discoveredNewestFirst = [...discoveredTrackers].sort((a, b) =>
    (b.runId ?? 0) - (a.runId ?? 0),
  )
  // sessionTrackers is oldest-registration-first; index is the registration
  // rank (higher = more recent). Rank an op by its retry time when it has one,
  // else by registration recency; retried ops (positive retry time) always sort
  // ahead of un-retried ones.
  const sessionRank = new Map(
    sessionTrackers.map((tr, index) => [
      tr.id,
      { retriedAt: retriedAt[tr.id] ?? 0, index },
    ]),
  )
  const sessionNewestFirst = [...sessionTrackers].sort((a, b) => {
    const ra = sessionRank.get(a.id)!
    const rb = sessionRank.get(b.id)!
    if (ra.retriedAt !== rb.retriedAt) return rb.retriedAt - ra.retriedAt
    return rb.index - ra.index
  })
  const trackers = [...sessionNewestFirst, ...discoveredNewestFirst]

  // Reconcile the optimistic-running set. An id clears once the poll observes
  // its re-run genuinely running or succeeded, so the real phase drives the UI
  // again. It ALSO clears on a fresh terminal FAILURE — a re-run that fails
  // again — but only once GitHub has actually re-touched the run since the
  // retry (run.updated_at >= retriedAt), so we don't clear on the stale
  // pre-retry "failed" the poll may still be reporting in the first cycle.
  // Without this, a retry-that-re-fails would spin as "running" (hiding
  // Retry/Dismiss) until the RETRY_OPTIMISTIC_MS safety timer. A safety timer
  // still backstops any id the poll never resolves.
  const optimisticSignature = [...optimisticRunning].sort().join(",")
  const realStateById = new Map(
    resolved.map(({ op, run, realPhase }) => [op.id, { realPhase, run }]),
  )
  useEffect(() => {
    if (optimisticRunning.size === 0) return
    setOptimisticRunning((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const id of prev) {
        const state = realStateById.get(id)
        if (!state) continue
        const { realPhase, run } = state
        const reFailed =
          realPhase === "failed" &&
          run !== null &&
          (runTimes(run).endedAtMs ?? 0) >= (retriedAt[id] ?? 0)
        if (realPhase === "running" || realPhase === "success" || reFailed) {
          next.delete(id)
          changed = true
        }
      }
      return changed ? next : prev
    })
    // Safety bound: drop any lingering optimistic ids after the window.
    const timer = window.setTimeout(
      () => setOptimisticRunning(new Set()),
      RETRY_OPTIMISTIC_MS,
    )
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optimisticSignature, phaseSignature])

  const retry = (id: string) => {
    if (retrying.has(id)) return
    const tracker = trackers.find((tr) => tr.id === id)
    if (!tracker?.retriable || tracker.runId === undefined || !org || !client) {
      return
    }
    setRetrying((prev) => new Set(prev).add(id))
    // Flip to "running" immediately so the banner reacts without waiting for the
    // poll, and keep the fast cadence so the real transition is picked up soon.
    setOptimisticRunning((prev) => new Set(prev).add(id))
    // rerun-failed-jobs reuses the SAME run id, so the terminal latch (which is
    // monotonic per binding) would otherwise pin the pre-retry "failed" forever
    // — resurrecting a stale red row (with a live Retry button) once the re-run
    // scrolls out of the poll window. Clear the latch so the re-run re-latches
    // its NEW outcome (success or failure) from scratch. optimisticRunning +
    // the persisted boundRunId keep the row from being GC'd during the gap.
    setLatchedPhase((prev) => {
      if (prev[id] === undefined) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    // Treat the retry as a fresh action so the tracker leads the banner.
    setRetriedAt((prev) => ({ ...prev, [id]: nowMs() }))
    bumpExpecting()
    retryMutation.mutate({ trackerId: id, runId: tracker.runId })
  }

  const anyFailed = trackers.some((tr) => tr.phase === "failed")

  return {
    org,
    trackers,
    anyFailed,
    dismiss,
    retry,
    retrying,
  }
}
