import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react"

// A teacher action this session that triggered a workflow; the banner turns each
// into a tracker bound to its run. Attribution anchors:
//  - "sha":        a push run (publish-pages), matched by head_sha.
//  - "sinceRunId": a workflow_dispatch run (collect-scores / regrade), matched
//                  by workflow + the oldest run past the pre-POST baseline.
export type ActionAnchor =
  | { kind: "sha"; sha: string }
  | { kind: "sinceRunId"; workflow: string; sinceRunId: number | null }

export type ActionOperation = {
  // Stable id for dedup, storage, and dismissal.
  id: string
  org: string
  // Human label, already translated by the caller.
  label: string
  anchor: ActionAnchor
  // Dispatch time; anchors GC and same-workflow registration order. Survives a
  // remount via sessionStorage.
  startedAt: number
}

type ActionActivityContextValue = {
  // Record a session op for later run attribution. Returns its id.
  register: (op: Omit<ActionOperation, "id" | "startedAt">) => string
  // Ops recorded this session for the org, oldest first (stable order for
  // same-workflow disambiguation).
  operationsForOrg: (org: string | undefined) => ActionOperation[]
  // Time of the most recent register() for an org (0 if none) — the banner uses
  // it to appear and poll immediately, before the run shows in the API.
  lastRegisteredAt: (org: string | undefined) => number
  // Whether the teacher dismissed an op (hidden from the banner).
  isDismissed: (opId: string) => boolean
  // Dismiss an op's tracker. Idempotent.
  dismiss: (opId: string) => void
  // Forget an op entirely (GC). Idempotent.
  clearOp: (opId: string) => void
}

const ActionActivityContext = createContext<ActionActivityContextValue | null>(
  null,
)

const STORAGE_KEY = "cl50:action-activity"

// Drop ops older than this — a bounded window stops a long-lived tab from
// matching a stale op to an unrelated later run.
const OP_TTL_MS = 15 * 60 * 1000

let opSeq = 0
const nextOpId = () => `op-${Date.now()}-${++opSeq}`

// Persisted shape: ops + dismissed op ids (so a dismissal survives a remount).
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
    // Best-effort; in-memory tracking still works this mount.
  }
}

// Records session-initiated GitHub operations for the banner. Mounted above the
// router so a registration survives the page that fired it navigating away;
// sessionStorage-backed (tab-scoped) to match the trackers' lifetime.
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

  const dismiss = useCallback((opId: string) => {
    setState((prev) => {
      if (prev.dismissed.includes(opId)) return prev
      const next: PersistedState = {
        ops: prev.ops,
        dismissed: [...prev.dismissed, opId],
      }
      saveState(next)
      return next
    })
  }, [])

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

// Access the registry. Returns a no-op registry outside a provider
// (isolation/tests) so callers stay simple.
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
