import {
  createContext,
  useContext,
  useMemo,
  type PropsWithChildren,
} from "react"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { useClassroomRole } from "@/hooks/useClassroomRole"
import { useTeacherTeamMigration } from "@/hooks/useTeacherTeamMigration"
import { useTeamDescriptionBackfill } from "@/hooks/useTeamDescriptionBackfill"
import { isTeacherRole, type ResolvedRole } from "@/authz"

// The single authoritative effective-role signal for the current classroom,
// resolved ONCE at the $org/$classroom boundary and shared with every child
// page + guard. Carries the fine classroom role (teacher/ta/student) plus
// the `roleResolved` load signal; permission verdicts are derived at call sites
// through the central `can()` policy off `role` (preview-aware; `actualRole` is
// the real one).
export type ClassroomRoleContextValue = {
  role: ResolvedRole
  actualRole: ResolvedRole
  isLoading: boolean
  // An elevation (teacher/ta) read settled in a non-definitive error with
  // the role still `unresolved` and nothing in flight — the guard shows an
  // error+retry surface instead of holding a spinner forever.
  isError: boolean
  // Re-run the classroom team reads (the error surface's retry).
  retry: () => void
  // Whether the fine role has settled (not `unresolved`) — the spinner-vs-render
  // signal. NOT a permission verdict: gate access via can(), gate loading state
  // via this.
  roleResolved: boolean
}

const ClassroomRoleContext = createContext<ClassroomRoleContextValue | null>(
  null,
)

// Resolve the classroom role from the three per-classroom team reads. One
// resolution per classroom mount; permission verdicts come from can() at the
// call site off `role`.
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

  // Self-heal the instructor -> teacher team rename on classroom entry, for the
  // whole classroom subtree rather than only the settings page. Gated on the
  // viewer being an org owner (the resolved teacher role) since the migration
  // creates/deletes teams and commits config; use actualRole so a teacher
  // previewing as a lower role still triggers the (idempotent) heal.
  useTeacherTeamMigration(org, classroom, isTeacherRole(actualRole))

  // Backfill the classroom50/team/v1 bootstrap record onto the student team's
  // description (the web mirror of the CLI's write-at-create), so classrooms
  // created via the GUI or before this feature converge on any owner entry.
  // Same gate/rationale as the migration above: an org-owner PATCH, keyed on
  // actualRole so a preview still triggers the idempotent reconcile.
  useTeamDescriptionBackfill(org, classroom, isTeacherRole(actualRole))

  const roleResolved = role !== "unresolved"

  return {
    role,
    actualRole,
    isLoading,
    isError,
    retry: refetch,
    roleResolved,
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
      resolved.roleResolved,
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
