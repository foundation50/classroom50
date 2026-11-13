import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react"

import { logger } from "@/lib/logger"
import type { ActionAnchor, ActionOperation } from "@/util/actionActivity"

const log = logger.scope("context:actions")

export type { ActionAnchor, ActionOperation }

type ActionActivityContextValue = {
  // Record a session op for later run attribution. Returns its id.
  register: (op: Omit<ActionOperation, "id" | "startedAt">) => string
  // Ops recorded this session for the org, oldest first (stable order for
  // same-workflow disambiguation).
  operationsForOrg: (org: string | undefined) => ActionOperation[]
  // Time of the most recent register() for an org (0 if none); the banner uses
  // it to appear and poll immediately, before the run shows in the API.
  lastRegisteredAt: (org: string | undefined) => number
  // Whether the teacher dismissed an op (hidden from the banner).
  isDismissed: (opId: string) => boolean
  // Dismiss an op's tracker. Idempotent.
  dismiss: (opId: string) => void
  // Forget an op entirely (GC). Idempotent.
  clearOp: (opId: string) => void
  // Whether the teacher hid a discovered run (one matching no session op).
  isRunDismissed: (runId: number) => boolean
  // Hide a discovered run from the banner. A view preference only: the run
  // stays whatever GitHub says it is. Idempotent.
  dismissRun: (runId: number) => void
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

// Dismissed discovered runs have no op to expire with, so bound the list
// instead; the banner only ever polls the 50 newest runs anyway.
const MAX_DISMISSED_RUNS = 50

// Persisted shape: ops + dismissed op ids (so a dismissal survives a remount)
// + dismissed discovered-run ids (a stuck queued run the teacher hid, #1159).
type PersistedState = {
  ops: ActionOperation[]
  dismissed: string[]
  dismissedRuns: number[]
}

const EMPTY_STATE: PersistedState = {
  ops: [],
  dismissed: [],
  dismissedRuns: [],
}

const loadState = (): PersistedState => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY_STATE
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    const cutoff = Date.now() - OP_TTL_MS
    const ops = Array.isArray(parsed.ops)
      ? parsed.ops.filter((op) => op.startedAt >= cutoff)
      : []
    const liveIds = new Set(ops.map((op) => op.id))
    const dismissed = Array.isArray(parsed.dismissed)
      ? parsed.dismissed.filter((id) => liveIds.has(id))
      : []
    const dismissedRuns = Array.isArray(parsed.dismissedRuns)
      ? parsed.dismissedRuns.filter((id) => typeof id === "number")
      : []
    return { ops, dismissed, dismissedRuns }
  } catch {
    log.warn("failed to load persisted action activity (corrupt storage)")
    return EMPTY_STATE
  }
}

const saveState = (state: PersistedState) => {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    log.warn("failed to persist action activity (storage quota/write)")
    // Best-effort; in-memory tracking still works this mount.
  }
}

// Records session-initiated GitHub operations for the banner. Above the router
// so a registration survives the page that fired it navigating away;
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
      log.info("action registered for run tracking", {
        org: op.org,
        label: op.label,
        anchor: op.anchor.kind,
      })
      setState((prev) => {
        const cutoff = Date.now() - OP_TTL_MS
        const ops = [...prev.ops.filter((o) => o.startedAt >= cutoff), full]
        const liveIds = new Set(ops.map((o) => o.id))
        const next: PersistedState = {
          ...prev,
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
        ...prev,
        dismissed: [...prev.dismissed, opId],
      }
      saveState(next)
      return next
    })
  }, [])

  const clearOp = useCallback((opId: string) => {
    setState((prev) => {
      if (!prev.ops.some((o) => o.id === opId)) return prev
      const next: PersistedState = {
        ...prev,
        ops: prev.ops.filter((o) => o.id !== opId),
        dismissed: prev.dismissed.filter((id) => id !== opId),
      }
      saveState(next)
      return next
    })
  }, [])

  const dismissRun = useCallback((runId: number) => {
    setState((prev) => {
      if (prev.dismissedRuns.includes(runId)) return prev
      const next: PersistedState = {
        ...prev,
        dismissedRuns: [...prev.dismissedRuns, runId].slice(
          -MAX_DISMISSED_RUNS,
        ),
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

  const dismissedRunSet = useMemo(
    () => new Set(state.dismissedRuns),
    [state.dismissedRuns],
  )
  const isRunDismissed = useCallback(
    (runId: number) => dismissedRunSet.has(runId),
    [dismissedRunSet],
  )

  const value = useMemo<ActionActivityContextValue>(
    () => ({
      register,
      operationsForOrg,
      lastRegisteredAt,
      isDismissed,
      dismiss,
      clearOp,
      isRunDismissed,
      dismissRun,
    }),
    [
      register,
      operationsForOrg,
      lastRegisteredAt,
      isDismissed,
      dismiss,
      clearOp,
      isRunDismissed,
      dismissRun,
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
    isRunDismissed: () => false,
    dismissRun: () => {},
  }
}
