import {
  createContext,
  useContext,
  useMemo,
  type PropsWithChildren,
} from "react"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { useGitHubRepo } from "@/hooks/github/hooks"
import { retryTransientGitHubError } from "@/hooks/github/errors"
import { useClassroomRole } from "@/hooks/useClassroomRole"
import {
  resolveTeacherVerdict,
  isStaffRole,
  type EffectiveRole,
} from "@/util/resolveRole"

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
  // Coarse staff verdict, DERIVED from the fine role (not the raw config-repo
  // read) so it can't diverge from `role`. Preview-aware via `role`.
  isTeacher: boolean
  isStudent: boolean
  isBlocked: boolean
  roleResolved: boolean
  showTeacherUi: boolean
}

const ClassroomRoleContext = createContext<ClassroomRoleContextValue | null>(
  null,
)

// Resolve the classroom role + coarse verdict from live reads. Both signals
// share the `classroom50` repo query (React Query dedupes the key), so mounting
// this provider triggers one resolution per classroom, not two.
function useClassroomRoleResolution(
  org: string | undefined,
  classroom: string | undefined,
): ClassroomRoleContextValue {
  const { user } = useGithubAuth()

  const { role, actualRole, isLoading } = useClassroomRole(
    org,
    classroom,
    user?.login,
  )

  // `isBlocked` is a config-repo access fact (403), independent of classroom
  // role; keep it from the repo verdict for the diagnostics surface. The retry
  // shares the `classroom50` query key with useClassroomRole, so no extra fetch.
  const staffRepoQuery = useGitHubRepo(org, "classroom50", {
    retry: retryTransientGitHubError,
  })
  const verdict = resolveTeacherVerdict({
    org,
    isSuccess: staffRepoQuery.isSuccess,
    permissions: staffRepoQuery.data?.permissions,
    error: staffRepoQuery.error,
  })

  // KTD-3: DERIVE the coarse staff verdict from the resolved fine role (which
  // already folds in team membership AND the "view as" clamp) so the two signals
  // can't diverge. Config-repo access alone must NOT grant teacher UI — an org
  // owner can read the config repo of a classroom they don't instruct, so keying
  // teacher UI on repo access (the old path) leaked the teacher view to an
  // owner-as-student. `unresolved` is the fail-closed sentinel (not resolved,
  // no teacher UI, not yet a definitive student).
  const roleResolved = role !== "unresolved"
  const isTeacher = isStaffRole(role) && roleResolved
  const isStudent = role === "student"

  return {
    role,
    actualRole,
    isLoading,
    isTeacher,
    isStudent,
    isBlocked: verdict.isBlocked,
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
      resolved.isTeacher,
      resolved.isStudent,
      resolved.isBlocked,
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
