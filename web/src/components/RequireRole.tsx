import { type ReactNode } from "react"
import { useParams } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { useOrgStaff } from "@/hooks/useOrgStaff"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import { useIsOrgOwner } from "@/context/githubOrgRole/useIsOrgOwner"
import { can } from "@/authz"
import NotFound from "@/components/NotFound"
import RoleResolvingFallback from "@/components/RoleResolvingFallback"
import { QueryErrorAlert } from "@/components/QueryErrorAlert"

// What a guarded surface requires:
// - "staff": any classroom staff (teacher/hta/ta) — for classroom CONTENT
//   (roster, authoring, submissions). On an org-level surface (no $classroom,
//   e.g. Published) this is the org-scoped team-based "staff of any classroom"
//   signal (useOrgStaff); on a classroom surface it reads the shared context.
// - "author": can author assignments in THIS classroom (teacher|hta) — the
//   config-repo write tier. A plain TA sees staff content but can't mutate, so
//   this excludes ta (and student). Reads the classroom context.
// - "teacher": teacher of THIS classroom (excludes TAs) — for classroom
//   SETTINGS. Reads the classroom context. Needs a $classroom route.
// - "owner": org admin only — for ORG-wide settings/setup. Reads the org-role
//   context. Independent of any classroom team (KTD-4).
export type RoleRequirement = "staff" | "author" | "teacher" | "owner"

// Gate page content by role. While the role resolves we show a spinner (never
// flash a 404 at a real staffer), then children or NotFound. Access is
// GitHub-enforced underneath; this UX guard 404s rather than 403s by design.
// Default `allow: "staff"` preserves the original behavior.
const RequireRole = ({
  children,
  allow = "staff",
}: {
  children: ReactNode
  allow?: RoleRequirement
}) => {
  if (allow === "owner") return <RequireOwner>{children}</RequireOwner>
  if (allow === "teacher") return <RequireTeacher>{children}</RequireTeacher>
  if (allow === "author") return <RequireAuthor>{children}</RequireAuthor>
  return <RequireStaff>{children}</RequireStaff>
}

// Shared gate shape: while the role read is in flight show a spinner (never
// flash a 404 at a real staffer); if the read SETTLED IN ERROR (retries
// exhausted, role still unresolved) show a retryable error instead of an
// indefinite spinner; then render children or NotFound. Each Require* wrapper
// computes its own `resolved`/`permitted` from the role signal it reads, and
// classroom gates pass `errored`/`onRetry` from the context.
const RoleGate = ({
  resolved,
  permitted,
  errored = false,
  onRetry,
  children,
}: {
  resolved: boolean
  permitted: boolean
  errored?: boolean
  onRetry?: () => void
  children: ReactNode
}) => {
  const { t } = useTranslation()
  if (errored && onRetry) {
    return (
      <QueryErrorAlert
        message={t("error.roleResolveFailed")}
        onRetry={onRetry}
        className="m-4"
      />
    )
  }
  if (!resolved) return <RoleResolvingFallback />
  if (!permitted) return <NotFound />
  return <>{children}</>
}

// Staff gate. On a classroom surface, read the shared classroom context; on an
// org-level surface (no classroom), fall back to the org-scoped team-based
// "staff of any classroom" signal, which needs no classroom in scope.
const RequireStaff = ({ children }: { children: ReactNode }) => {
  const { classroom } = useParams({ strict: false })
  if (classroom)
    return <RequireClassroomStaff>{children}</RequireClassroomStaff>
  return <RequireOrgStaff>{children}</RequireOrgStaff>
}

const RequireClassroomStaff = ({ children }: { children: ReactNode }) => {
  const { role, roleResolved, isError, retry } = useClassroomRoleContext()
  return (
    <RoleGate
      resolved={roleResolved}
      permitted={can("viewClassroomStaffContent", {
        classroomRole: role,
      })}
      errored={isError}
      onRetry={retry}
    >
      {children}
    </RoleGate>
  )
}

const RequireOrgStaff = ({ children }: { children: ReactNode }) => {
  const { org } = useParams({ strict: false })
  const { isStaff, roleResolved, isError, refetch } = useOrgStaff(org)
  return (
    <RoleGate
      resolved={roleResolved}
      permitted={can("viewOrgStaffContent", {
        orgStaff: isStaff,
      })}
      errored={isError}
      onRetry={refetch}
    >
      {children}
    </RoleGate>
  )
}

// Author gate: can author assignments in this classroom (teacher|hta). A TA
// sees staff content but can't mutate the config repo, so this is a tier above
// `staff` and below `teacher` (which is settings-only). Gate on `roleResolved`
// (the fine role short-circuits on the first confirmed elevation read).
const RequireAuthor = ({ children }: { children: ReactNode }) => {
  const { role, roleResolved, isError, retry } = useClassroomRoleContext()
  return (
    <RoleGate
      resolved={roleResolved}
      permitted={can("authorAssignments", {
        classroomRole: role,
      })}
      errored={isError}
      onRetry={retry}
    >
      {children}
    </RoleGate>
  )
}

// Teacher gate: teacher of this classroom (TAs excluded). An org owner is
// permitted only when they are on the classroom teacher team — org-admin
// status alone no longer grants classroom-teacher access (KTD-4). Gate on
// `roleResolved` (the fine role short-circuits to teacher on the teacher
// read alone) — NOT `!isLoading`, which would hold a confirmed teacher on
// the spinner while the irrelevant ta/student reads finish.
const RequireTeacher = ({ children }: { children: ReactNode }) => {
  const { role, roleResolved, isError, retry } = useClassroomRoleContext()
  return (
    <RoleGate
      resolved={roleResolved}
      permitted={can("editClassroomSettings", {
        classroomRole: role,
      })}
      errored={isError}
      onRetry={retry}
    >
      {children}
    </RoleGate>
  )
}

// Owner gate: org admin, read from the org-role context. Org-wide, independent
// of any classroom. A settled transient membership error surfaces a retryable
// error instead of an indefinite spinner (mirrors the classroom gates).
const RequireOwner = ({ children }: { children: ReactNode }) => {
  const { isOwner, isPending, isError, retry } = useIsOrgOwner()
  return (
    <RoleGate
      resolved={!isPending}
      permitted={isOwner}
      errored={isError}
      onRetry={retry}
    >
      {children}
    </RoleGate>
  )
}

export default RequireRole
