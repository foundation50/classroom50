import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react"
import type { ViewAsRole } from "@/authz"
import { logger } from "@/lib/logger"

const log = logger.scope("context:roleView")

// "View as" preview: a client-side lens letting a teacher/owner preview the
// app as a TA or student. Persisted per org+classroom in sessionStorage and
// applied DOWNGRADE-ONLY by useClassroomRole. CLASSROOM-scoped so a teacher who
// is a teacher in one classroom and a TA in another can't carry "view as
// student" across (a silent demote with no visible control to clear it); keying
// by org+classroom and clearing on classroom change isolates each.
type RoleViewContextValue = {
  viewAs: ViewAsRole | null
  setViewAs: (next: ViewAsRole | null) => void
}

const RoleViewContext = createContext<RoleViewContextValue | null>(null)

const STORAGE_PREFIX = "c50_view_as:"

// Scope the key to org + classroom. An org-level route (no classroom) returns
// null, so the lens is inert there.
const keyFor = (
  org: string | undefined,
  classroom: string | undefined,
): string | null =>
  org && classroom ? `${STORAGE_PREFIX}${org}:${classroom}` : null

function readStored(
  org: string | undefined,
  classroom: string | undefined,
): ViewAsRole | null {
  if (typeof window === "undefined") return null
  const key = keyFor(org, classroom)
  if (!key) return null
  const raw = sessionStorage.getItem(key)
  return raw === "hta" || raw === "ta" || raw === "student" ? raw : null
}

// Scoped to one org + classroom (re-synced below on either change), so the
// preview never leaks across orgs or classrooms. Stays mounted across
// navigation so the persistent app shell isn't torn down on an org/classroom
// switch.
export function RoleViewProvider({
  org,
  classroom,
  children,
}: PropsWithChildren<{
  org: string | undefined
  classroom: string | undefined
}>) {
  const [viewAs, setViewAsState] = useState<ViewAsRole | null>(() =>
    readStored(org, classroom),
  )

  // Re-read the stored preview whenever the org OR classroom changes (the
  // provider now stays mounted across org and classroom navigation, so it can't
  // rely on a remount to reset). Keeping it mounted lets the persistent app
  // shell's sidebar animate the menu-level swap on those navigations. The lens
  // stays isolated per org+classroom: a preview set in one never bleeds into
  // another, and org-less routes read `null` (inert).
  const prevScopeRef = useRef(keyFor(org, classroom))
  useEffect(() => {
    const scope = keyFor(org, classroom)
    if (prevScopeRef.current !== scope) {
      prevScopeRef.current = scope
      setViewAsState(readStored(org, classroom))
    }
  }, [org, classroom])

  const setViewAs = useCallback(
    (next: ViewAsRole | null) => {
      log.info("view-as role changed", {
        org,
        classroom,
        viewAs: next ?? "self",
      })
      setViewAsState(next)
      if (typeof window === "undefined") return
      const key = keyFor(org, classroom)
      if (!key) return
      if (next) sessionStorage.setItem(key, next)
      else sessionStorage.removeItem(key)
    },
    [org, classroom],
  )

  const value = useMemo(() => ({ viewAs, setViewAs }), [viewAs, setViewAs])

  return (
    <RoleViewContext.Provider value={value}>
      {children}
    </RoleViewContext.Provider>
  )
}

// Read the current preview. Returns a no-op default when no provider is mounted
// (e.g., org-less routes), so callers never null-check.
export function useRoleView(): RoleViewContextValue {
  return useContext(RoleViewContext) ?? { viewAs: null, setViewAs: () => {} }
}
