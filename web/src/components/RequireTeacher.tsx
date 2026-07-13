import { type ReactNode } from "react"
import { useParams } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { useConfigRepoAccess } from "@/hooks/useConfigRepoAccess"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import { useOrgRole } from "@/context/orgRole/OrgRoleProvider"
import { can } from "@/util/capabilities"
import NotFound from "@/components/NotFound"
import RoleResolvingFallback from "@/components/RoleResolvingFallback"
import { QueryErrorAlert } from "@/components/QueryErrorAlert"

// What a guarded surface requires:
// - "staff": any classroom staff (instructor/ta) — for classroom CONTENT
//   (roster, authoring, submissions). Backed by config-repo access. On an
//   org-level surface (no $classroom, e.g. Published) this is the org-scoped
//   config-repo verdict; on a classroom surface it reads the shared context.
// - "instructor": instructor of THIS classroom (excludes TAs) — for classroom
//   SETTINGS. Reads the classroom context. Needs a $classroom route.
// - "owner": org admin only — for ORG-wide settings/setup. Reads the org-role
//   context. Independent of any classroom team (KTD-4).
export type RequireRole = "staff" | "instructor" | "owner"

// Gate page content by role. While the role resolves we show a spinner (never
// flash a 404 at a real teacher), then children or NotFound. Access is
// GitHub-enforced underneath; this UX guard 404s rather than 403s by design.
// Default `allow: "staff"` preserves the original behavior.
const RequireTeacher = ({
  children,
  allow = "staff",
}: {
  children: ReactNode
  allow?: RequireRole
}) => {
  if (allow === "owner") return <RequireOwner>{children}</RequireOwner>
  if (allow === "instructor")
    return <RequireInstructor>{children}</RequireInstructor>
  return <RequireStaff>{children}</RequireStaff>
}

// Shared gate shape: while the role read is in flight show a spinner (never
// flash a 404 at a real teacher); if the read SETTLED IN ERROR (retries
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
// org-level surface (no classroom), fall back to the org-scoped config-repo
// verdict, which needs no classroom.
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
  const { showTeacherUi, roleResolved, isError, refetch } =
    useConfigRepoAccess(org)
  return (
    <RoleGate
      resolved={roleResolved}
      permitted={can("viewOrgStaffContent", {
        orgStaff: showTeacherUi,
      })}
      errored={isError}
      onRetry={refetch}
    >
      {children}
    </RoleGate>
  )
}

// Instructor gate: instructor of this classroom (TAs excluded). An org owner is
// permitted only when they are on the classroom instructor team — org-admin
// status alone no longer grants classroom-instructor access (KTD-4). Gate on
// `roleResolved` (the fine role short-circuits to instructor on the instructor
// read alone) — NOT `!isLoading`, which would hold a confirmed instructor on
// the spinner while the irrelevant ta/student reads finish.
const RequireInstructor = ({ children }: { children: ReactNode }) => {
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
  const { orgRole, isError, retry } = useOrgRole()
  return (
    <RoleGate
      resolved={orgRole !== "unresolved"}
      permitted={can("manageOrg", { orgRole })}
      errored={isError}
      onRetry={retry}
    >
      {children}
    </RoleGate>
  )
}

export default RequireTeacher
