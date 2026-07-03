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

// Poll cadence: fast (5s) while there's activity, slow (15s) when idle. The
// query only runs on an org route.
const POLL_ACTIVE_MS = 5000
const POLL_IDLE_MS = 15_000

// After a commit/dispatch, hold the fast cadence for this window so the run
// surfaces quickly.
const PENDING_GRACE_MS = 20_000

// Drop a still-pending op only if it NEVER produced a run within this window (a
// mis-registration). Generous — a push-triggered deploy can take minutes. An op
// that bound to a run or finished is never dropped by this; it persists as
// history until dismissed.
const PENDING_TTL_MS = 5 * 60_000

// After a retry, show the tracker "running" for this window (holding the poll
// fast) so the banner flips immediately — GitHub takes a few seconds to report
// the re-run as in_progress.
const RETRY_OPTIMISTIC_MS = 20_000

// Generic label for a discovered run (cron, another teacher) matching no op.
const WORKFLOW_LABEL_KEY: Record<string, string> = {
  "publish-pages.yaml": "actionsBanner.workflow.publishPages",
  "collect-scores.yaml": "actionsBanner.workflow.collectScores",
  "regrade.yaml": "actionsBanner.workflow.regrade",
}

// One row in the banner: an action and its live state.
export type Tracker = {
  // Session op id, or `run-<id>` for a discovered run.
  id: string
  label: string
  phase: TrackerPhase
  // Run's GitHub URL; absent only for a still-pending op.
  htmlUrl?: string
  // Resolved run id, when known — enables retry.
  runId?: number
  // Terminal session-op trackers can be dismissed; discovered/non-terminal cannot.
  dismissible: boolean
  // A failed run with a known runId can be retried.
  retriable: boolean
  // Run start (ms epoch), for elapsed time. Undefined while pending.
  startedAtMs?: number
  // Run finish (ms epoch); undefined while running (UI keeps ticking).
  endedAtMs?: number
}

export type ActionActivity = {
  org: string | undefined
  trackers: Tracker[]
  anyFailed: boolean
  dismiss: (id: string) => void
  retry: (id: string) => void
  // Tracker ids with a retry in flight (spinner / disabled X).
  retrying: ReadonlySet<string>
}

// Drives the global activity banner: one repo-wide poll advances a collection of
// per-operation trackers. Each session op resolves to its own run and reflects
// that run's real status/conclusion; runs matching no op surface as "discovered"
// trackers. Terminal trackers persist as history until dismissed.
export function useActionActivity(): ActionActivity {
  const { t } = useTranslation()
  const org = useActiveOrg()
  const client = useOptionalGitHubClient()
  const { operationsForOrg, lastRegisteredAt, isDismissed, dismiss, clearOp } =
    useActionActivityRegistry()
  const toast = useOptionalToast()
  const queryClient = useQueryClient()

  const registeredAt = lastRegisteredAt(org)

  // Seeded with the mount value so only a NEWER registration re-arms the fast
  // poll (ops persist in sessionStorage, so registeredAt may predate this mount).
  const lastSeenRegisteredAt = useRef(registeredAt)
  // While nowMs() < expectingUntil the poll stays fast — set on a new
  // registration and on retry. A self-expiring timestamp (not a boolean+timer)
  // can't get stuck on: once the window passes, the poll backs off on its own.
  const [expectingUntil, setExpectingUntil] = useState(0)
  const bumpExpecting = useCallback(
    () => setExpectingUntil(nowMs() + PENDING_GRACE_MS),
    [],
  )

  // `retrying`: in-flight retry requests (spinner + double-submit guard).
  // `optimisticRunning`: ids shown "running" right after a retry.
  const [retrying, setRetrying] = useState<Set<string>>(new Set())
  const [optimisticRunning, setOptimisticRunning] = useState<Set<string>>(
    new Set(),
  )
  // Last retry time per op. A retry is a fresh action, so the retried tracker
  // jumps to the front (see ordering below).
  const [retriedAt, setRetriedAt] = useState<Record<string, number>>({})

  // Read before the query so the poll can stay alive while any op is still
  // outstanding (e.g. a deploy whose run hasn't appeared yet).
  const ops = operationsForOrg(org)

  const runsQuery = useQuery({
    queryKey: activityRunsKey(org ?? ""),
    queryFn: ({ signal }) =>
      listActiveAndRecentRuns(client!, org ?? "", signal),
    enabled: Boolean(org && client),
    // Fast while anything runs or a dispatch/retry is expected; slow while a
    // finished run or outstanding op is still shown; stop (false) once there's
    // nothing to track. A new dispatch/retry re-arms via invalidate +
    // bumpExpecting, so an idle tab doesn't poll GitHub forever.
    refetchInterval: (query) => {
      const runs = query.state.data ?? []
      const anyRunning = runs.some(isRunning)
      const expecting = nowMs() < expectingUntil
      if (anyRunning || expecting || optimisticRunning.size > 0) {
        return POLL_ACTIVE_MS
      }
      return runs.length > 0 || ops.length > 0 ? POLL_IDLE_MS : false
    },
    // Keep polling in a backgrounded tab so a run watched on github.com still
    // updates here. Bounded by the refetchInterval above (idle tabs stop).
    refetchIntervalInBackground: true,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  })

  const allRuns = runsQuery.data ?? []

  const retryMutation = useMutation({
    mutationFn: ({ runId }: { trackerId: string; runId: number }) =>
      rerunFailedRun(client!, org ?? "", runId),
    onError: (err, { trackerId }) => {
      // Drop the optimistic flag so the tracker falls back to its real state.
      setOptimisticRunning((prev) => {
        if (!prev.has(trackerId)) return prev
        const next = new Set(prev)
        next.delete(trackerId)
        return next
      })
      // Surface the rejection (403 not-rerunnable, no Actions:write, run too
      // old) so the teacher doesn't re-click into the same failure. Keyed so
      // repeated retries replace the toast. No-op outside a NotificationProvider.
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

  // On a new registration, poll immediately and open the expecting window so
  // the pending tracker shows at once.
  useEffect(() => {
    if (!org) return
    if (registeredAt <= lastSeenRegisteredAt.current) return
    lastSeenRegisteredAt.current = registeredAt
    bumpExpecting()
    void queryClient.invalidateQueries({
      queryKey: activityRunsKey(org),
    })
  }, [registeredAt, org, queryClient, bumpExpecting])

  // Stable op -> runId bindings (in state, so render stays pure). Once an op
  // resolves to a run we remember it, so a sibling clearing can't re-shuffle
  // which run a still-showing op points at.
  const [boundRunId, setBoundRunId] = useState<Record<string, number>>({})

  // Last observed TERMINAL phase per op, latched so a finished tracker keeps its
  // outcome after its run ages out of the polled window.
  const [latchedPhase, setLatchedPhase] = useState<
    Record<string, TrackerPhase>
  >({})

  const claimed = new Set<number>()
  const runsById = new Map(allRuns.map((r) => [r.id, r]))
  const resolved = ops.map((op) => {
    const remembered = boundRunId[op.id]
    // A bound op stays pinned to THAT run — never re-resolves. A poll that
    // transiently omits it yields null (reads as pending/latched) rather than
    // falling through to resolveOpRun, which would re-bind onto a sibling's run.
    // Claim the remembered id even when absent so a sibling can't grab it.
    let run: GitHubWorkflowRun | null
    if (remembered !== undefined) {
      run = claimed.has(remembered) ? null : (runsById.get(remembered) ?? null)
      claimed.add(remembered)
    } else {
      run = resolveOpRun(op, allRuns, claimed)
      if (run) claimed.add(run.id)
    }
    const realPhase = trackerPhase(run)
    // Show "running" optimistically until the poll sees the re-run in flight.
    let phase =
      optimisticRunning.has(op.id) && realPhase !== "running"
        ? "running"
        : realPhase
    // Latch a terminal phase so a finished tracker survives its run scrolling
    // out of the window (which would otherwise revert it to pending and GC it).
    const latched = latchedPhase[op.id]
    if (
      phase === "pending" &&
      (latched === "failed" || latched === "success")
    ) {
      phase = latched
    }
    return { op, run, phase, realPhase }
  })

  // Persist newly-formed bindings; drop those for ops that left the store.
  const bindingSignature = resolved
    .map(({ op, run }) => `${op.id}:${run?.id ?? ""}`)
    .join(",")
  useEffect(() => {
    setBoundRunId((prev) => {
      const next: Record<string, number> = {}
      let changed = false
      for (const { op, run } of resolved) {
        // Keep the first run an op bound to; don't overwrite on re-resolution.
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

  // Re-run lifecycle effects only when a phase actually changes.
  const phaseSignature = resolved.map((r) => `${r.op.id}:${r.phase}`).join(",")

  // Latch terminal phases (survive scroll-out); prune ops no longer in the store.
  useEffect(() => {
    setLatchedPhase((prev) => {
      const next: Record<string, TrackerPhase> = {}
      let changed = false
      for (const { op, phase } of resolved) {
        const carried = prev[op.id]
        // Keep an existing terminal latch; else adopt a newly-terminal phase.
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

  // Time-based GC (kept in an effect so render stays pure): drop a pending op
  // only if it never produced a run within the window. An op that bound to a run
  // or reached a terminal state is real history and persists until dismissed.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const at = nowMs()
    const deadlines: number[] = []
    for (const { op, phase } of resolved) {
      if (phase !== "pending") continue
      if (
        boundRunId[op.id] !== undefined ||
        latchedPhase[op.id] !== undefined
      ) {
        continue
      }
      const due = op.startedAt + PENDING_TTL_MS
      if (at >= due) clearOp(op.id)
      else deadlines.push(due)
    }
    const nextDue = deadlines.sort((a, b) => a - b)[0]
    if (nextDue === undefined) return
    // Re-arm for the nearest deadline so clearing happens promptly.
    const id = window.setTimeout(
      () => setTick((n) => n + 1),
      Math.max(0, nextDue - at) + 50,
    )
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseSignature, tick, clearOp])

  // Session trackers: every non-dismissed op, as a pure projection of ops +
  // resolved phase (time-based removal is handled by the GC effect above). The
  // runId/URL fall back to the stable binding so a transient poll gap doesn't
  // drop the "View run" link.
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
        // Terminal ops persist as history and can be dismissed; running/pending can't.
        dismissible: phase === "success" || phase === "failed",
        retriable: phase === "failed" && stableRunId !== undefined,
        startedAtMs: times.startedAtMs,
        endedAtMs: times.endedAtMs,
      }
    })

  // Discovered trackers: in-flight runs matching no session op (cron, another
  // teacher). Shown while running; dropped when they finish.
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

  // Newest-first so trackers[0] leads the collapsed header: session ops (a
  // retried op jumps ahead as a fresh action, else reverse registration order),
  // then discovered runs by descending id.
  const discoveredNewestFirst = [...discoveredTrackers].sort(
    (a, b) => (b.runId ?? 0) - (a.runId ?? 0),
  )
  // sessionTrackers is oldest-first; rank by retry time (retried ops lead), else
  // by registration recency (higher index = more recent).
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

  // Reconcile the optimistic-running set: clear an id once the poll sees its
  // re-run running or succeeded — or re-failed, but only once GitHub has
  // re-touched the run since the retry (endedAtMs >= retriedAt), so we don't
  // clear on the stale pre-retry "failed". A safety timer backstops the rest.
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
    // Flip to "running" immediately and hold the poll fast.
    setOptimisticRunning((prev) => new Set(prev).add(id))
    // rerun-failed-jobs reuses the same run id, so the monotonic latch would
    // otherwise pin the pre-retry "failed" forever (resurrecting a stale red row
    // once the re-run scrolls out). Clear it so the re-run re-latches its new
    // outcome; optimisticRunning + boundRunId keep the row from being GC'd.
    setLatchedPhase((prev) => {
      if (prev[id] === undefined) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    // Retry is a fresh action — lead the banner.
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
