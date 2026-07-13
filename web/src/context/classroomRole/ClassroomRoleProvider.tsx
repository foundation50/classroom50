import {
  createContext,
  useContext,
  useMemo,
  type PropsWithChildren,
} from "react"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { useClassroomRole } from "@/hooks/useClassroomRole"
import { isStaffRole, type EffectiveRole } from "@/util/resolveRole"

// The single authoritative effective-role signal for the current classroom,
// resolved ONCE at the $org/$classroom boundary and shared with every child
// page + guard. Carries both the fine classroom role (instructor/ta/student)
// and the coarse staff verdict (showTeacherUi/isStudent/...) DERIVED from that
// fine role, so the two can't diverge. Preview-aware fields respect the
// downgrade-only "view as" lens; `actualRole` is the real one.
export type ClassroomRoleContextValue = {
  role: EffectiveRole
  actualRole: EffectiveRole
  isLoading: boolean
  // An elevation (instructor/ta) read settled in a non-definitive error with
  // the role still `unresolved` and nothing in flight — the guard shows an
  // error+retry surface instead of holding a spinner forever.
  isError: boolean
  // Re-run the classroom team reads (the error surface's retry).
  retry: () => void
  // Coarse staff verdict, DERIVED from the fine role (not a separate config-repo
  // read) so it can't diverge from `role`. Preview-aware via `role`.
  isTeacher: boolean
  isStudent: boolean
  roleResolved: boolean
  showTeacherUi: boolean
}

const ClassroomRoleContext = createContext<ClassroomRoleContextValue | null>(
  null,
)

// Resolve the classroom role from the three per-classroom team reads and derive
// the coarse staff verdict from it. One resolution per classroom mount.
function useClassroomRoleResolution(
  org: string | undefined,
  classroom: string | undefined,
): ClassroomRoleContextValue {
  const { user } = useGithubAuth()

  const { role, actualRole, isLoading, isError, refetch } = useClassroomRole(
    org,
    classroom,
    user?.login,
  )

  // DERIVE the coarse staff verdict from the resolved fine role (which already
  // folds in team membership AND the "view as" clamp) so the two can't diverge.
  // `unresolved` is the fail-closed sentinel (not resolved, no teacher UI, not
  // yet a definitive student).
  const roleResolved = role !== "unresolved"
  const isTeacher = isStaffRole(role) && roleResolved
  const isStudent = role === "student"

  return {
    role,
    actualRole,
    isLoading,
    isError,
    retry: refetch,
    isTeacher,
    isStudent,
    roleResolved,
    showTeacherUi: isTeacher,
  }
}

// Provider mounted at $org/$classroom/route.tsx around the classroom subtree.
export function ClassroomRoleProvider({
  org,
  classroom,
  children,
}: PropsWithChildren<{
  org: string | undefined
  classroom: string | undefined
}>) {
  const resolved = useClassroomRoleResolution(org, classroom)

  const value = useMemo(
    () => resolved,
    // Spread the primitives so a stable resolution doesn't churn consumers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      resolved.role,
      resolved.actualRole,
      resolved.isLoading,
      resolved.isError,
      resolved.retry,
      resolved.isTeacher,
      resolved.isStudent,
      resolved.roleResolved,
      resolved.showTeacherUi,
    ],
  )
  return (
    <ClassroomRoleContext.Provider value={value}>
      {children}
    </ClassroomRoleContext.Provider>
  )
}

// Read the resolved classroom role. Throws when used outside a provider so a
// classroom surface can't silently gate on a stale default — every classroom
// page renders under the boundary that mounts this.
export function useClassroomRoleContext(): ClassroomRoleContextValue {
  const ctx = useContext(ClassroomRoleContext)
  if (!ctx) {
    throw new Error(
      "useClassroomRoleContext must be used within a ClassroomRoleProvider",
    )
  }
  return ctx
}

// Like useClassroomRoleContext but returns null off-route (no provider). For
// surfaces rendered on BOTH org-level and classroom routes (e.g. the drawer
// footer), which read the classroom role when in a classroom and fall back to
// org-level signals otherwise. Mirrors useRoleView's safe off-route default.
export function useClassroomRoleContextOptional(): ClassroomRoleContextValue | null {
  return useContext(ClassroomRoleContext)
}
