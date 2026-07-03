import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react"

// A teacher action taken in this browser session that triggers a GitHub Actions
// workflow. The activity banner turns each of these into a per-operation
// tracker (collect-score-like) that binds to its own run and reflects that
// run's real lifecycle.
//
// Attribution anchors, by trigger kind:
//  - "sha":         a push-triggered run (publish-pages after a commit). Match
//                   the run by head_sha === sha.
//  - "sinceRunId":  a workflow_dispatch run (collect-scores / regrade). The
//                   dispatch API returns no run id, so we recorded the newest
//                   run id before the POST; the run is the oldest one with a
//                   larger id for the same workflow.
export type ActionAnchor =
  | { kind: "sha"; sha: string }
  | { kind: "sinceRunId"; workflow: string; sinceRunId: number | null }

export type ActionOperation = {
  // Stable id for dedup, storage, and dismissal.
  id: string
  org: string
  // Human label for the triggering action (already translated by the caller).
  label: string
  anchor: ActionAnchor
  // Wall-clock dispatch time; anchors GC and (for dispatches racing on the same
  // workflow) the registration order used to disambiguate runs. Survives a
  // remount via sessionStorage.
  startedAt: number
}

type ActionActivityContextValue = {
  // Record a session operation for later run attribution. Returns its id.
  register: (op: Omit<ActionOperation, "id" | "startedAt">) => string
  // Operations recorded this session for the given org (oldest first, so a
  // stable registration order is available for same-workflow disambiguation).
  operationsForOrg: (org: string | undefined) => ActionOperation[]
  // Wall-clock time of the most recent register() for an org (0 if none). The
  // banner uses this to appear immediately on a commit/dispatch and to trigger
  // an off-schedule poll, before the resulting run shows up in the Actions API.
  lastRegisteredAt: (org: string | undefined) => number
  // Whether an op has been dismissed by the teacher (a failed tracker they
  // closed). Dismissed ops are hidden from the banner.
  isDismissed: (opId: string) => boolean
  // Dismiss an op's tracker (used for a failed row). Idempotent.
  dismiss: (opId: string) => void
  // Forget an op entirely (used by the banner to GC a success tracker after its
  // flash, so it doesn't re-surface). Idempotent.
  clearOp: (opId: string) => void
}

const ActionActivityContext = createContext<ActionActivityContextValue | null>(
  null,
)

const STORAGE_KEY = "cl50:action-activity"

// Drop operations older than this. A publish-pages deploy or a collect-scores
// run finishes well within a few minutes; keeping a bounded window stops a
// long-lived tab from matching a stale op to an unrelated later run.
const OP_TTL_MS = 15 * 60 * 1000

let opSeq = 0
const nextOpId = () => `op-${Date.now()}-${++opSeq}`

// Persisted shape: the ops plus the set of dismissed op ids (so a dismissed
// failure stays dismissed across a remount).
type PersistedState = { ops: ActionOperation[]; dismissed: string[] }

const loadState = (): PersistedState => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return { ops: [], dismissed: [] }
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    const cutoff = Date.now() - OP_TTL_MS
    const ops = Array.isArray(parsed.ops)
      ? parsed.ops.filter((op) => op.startedAt >= cutoff)
      : []
    const liveIds = new Set(ops.map((op) => op.id))
    const dismissed = Array.isArray(parsed.dismissed)
      ? parsed.dismissed.filter((id) => liveIds.has(id))
      : []
    return { ops, dismissed }
  } catch {
    return { ops: [], dismissed: [] }
  }
}

const saveState = (state: PersistedState) => {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Best-effort persistence; in-memory tracking still works this mount.
  }
}

// Records session-initiated GitHub operations so the activity banner can build a
// per-operation tracker for each. Mounted above the router (alongside
// NotificationProvider) so a registration survives the page that fired it
// navigating away. sessionStorage-backed (tab-scoped) to match the "this
// session" lifetime of the dispatch trackers.
export function ActionActivityProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<PersistedState>(() => loadState())

  const register = useCallback(
    (op: Omit<ActionOperation, "id" | "startedAt">) => {
      const full: ActionOperation = {
        ...op,
        id: nextOpId(),
        startedAt: Date.now(),
      }
      setState((prev) => {
        const cutoff = Date.now() - OP_TTL_MS
        const ops = [...prev.ops.filter((o) => o.startedAt >= cutoff), full]
        const liveIds = new Set(ops.map((o) => o.id))
        const next: PersistedState = {
          ops,
          dismissed: prev.dismissed.filter((id) => liveIds.has(id)),
        }
        saveState(next)
        return next
      })
      return full.id
    },
    [],
  )

  const dismiss = useCallback(
    (opId: string) => {
      setState((prev) => {
        if (prev.dismissed.includes(opId)) return prev
        const next: PersistedState = {
          ops: prev.ops,
          dismissed: [...prev.dismissed, opId],
        }
        saveState(next)
        return next
      })
    },
    [],
  )

  const clearOp = useCallback((opId: string) => {
    setState((prev) => {
      if (!prev.ops.some((o) => o.id === opId)) return prev
      const ops = prev.ops.filter((o) => o.id !== opId)
      const next: PersistedState = {
        ops,
        dismissed: prev.dismissed.filter((id) => id !== opId),
      }
      saveState(next)
      return next
    })
  }, [])

  const operationsForOrg = useCallback(
    (org: string | undefined) => {
      if (!org) return []
      return state.ops
        .filter((op) => op.org === org)
        .sort((a, b) => a.startedAt - b.startedAt)
    },
    [state.ops],
  )

  const lastRegisteredAt = useCallback(
    (org: string | undefined) => {
      if (!org) return 0
      let latest = 0
      for (const op of state.ops) {
        if (op.org === org && op.startedAt > latest) latest = op.startedAt
      }
      return latest
    },
    [state.ops],
  )

  const dismissedSet = useMemo(
    () => new Set(state.dismissed),
    [state.dismissed],
  )
  const isDismissed = useCallback(
    (opId: string) => dismissedSet.has(opId),
    [dismissedSet],
  )

  const value = useMemo<ActionActivityContextValue>(
    () => ({
      register,
      operationsForOrg,
      lastRegisteredAt,
      isDismissed,
      dismiss,
      clearOp,
    }),
    [
      register,
      operationsForOrg,
      lastRegisteredAt,
      isDismissed,
      dismiss,
      clearOp,
    ],
  )

  return (
    <ActionActivityContext.Provider value={value}>
      {children}
    </ActionActivityContext.Provider>
  )
}

// Access the registry from any component under the provider. Returns a no-op
// registry when used outside one (isolation/tests) so callers stay simple.
export function useActionActivityRegistry(): ActionActivityContextValue {
  const ctx = useContext(ActionActivityContext)
  if (ctx) return ctx
  return {
    register: () => "",
    operationsForOrg: () => [],
    lastRegisteredAt: () => 0,
    isDismissed: () => false,
    dismiss: () => {},
    clearOp: () => {},
  }
}
