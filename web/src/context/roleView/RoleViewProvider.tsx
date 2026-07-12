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
import type { ViewAsRole } from "@/util/resolveRole"
import { logger } from "@/lib/logger"

const log = logger.scope("context:roleView")

// "View as" preview: a client-side lens letting an instructor/owner preview the
// app as a TA or student. Persisted per org+classroom in sessionStorage and
// applied DOWNGRADE-ONLY by useClassroomRole. CLASSROOM-scoped so a teacher who
// is an instructor in one classroom and a TA in another can't carry "view as
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
  return raw === "ta" || raw === "student" ? raw : null
}

// Scoped to one org (remounts on org change via `key`) and one classroom
// (re-synced below), so the preview never leaks across orgs or classrooms.
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

  // On classroom change (the provider stays mounted across intra-org
  // navigation), re-read this classroom's stored preview so one set in classroom
  // A never bleeds into classroom B.
  const prevClassroomRef = useRef(classroom)
  useEffect(() => {
    if (prevClassroomRef.current !== classroom) {
      prevClassroomRef.current = classroom
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
// (e.g. org-less routes), so callers never null-check.
export function useRoleView(): RoleViewContextValue {
  return useContext(RoleViewContext) ?? { viewAs: null, setViewAs: () => {} }
}
