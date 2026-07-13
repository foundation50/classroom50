import { type ReactNode } from "react"
import { useParams } from "@tanstack/react-router"
import { useConfigRepoAccess } from "@/hooks/useConfigRepoAccess"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import { useOrgRole } from "@/context/orgRole/OrgRoleProvider"
import { can } from "@/util/capabilities"
import NotFound from "@/components/NotFound"
import RoleResolvingFallback from "@/components/RoleResolvingFallback"

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

// Shared gate shape: hold a spinner until the signal resolves (never flash a 404
// at a real teacher), then render children or NotFound. Each Require* wrapper
// computes its own `resolved`/`permitted` from the role signal it reads.
const RoleGate = ({
  resolved,
  permitted,
  children,
}: {
  resolved: boolean
  permitted: boolean
  children: ReactNode
}) => {
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
  const { role, roleResolved } = useClassroomRoleContext()
  return (
    <RoleGate
      resolved={roleResolved}
      permitted={can("viewClassroomStaffContent", {
        classroomRole: role,
      })}
    >
      {children}
    </RoleGate>
  )
}

const RequireOrgStaff = ({ children }: { children: ReactNode }) => {
  const { org } = useParams({ strict: false })
  const { showTeacherUi, roleResolved } = useConfigRepoAccess(org)
  return (
    <RoleGate
      resolved={roleResolved}
      permitted={can("viewOrgStaffContent", {
        orgStaff: showTeacherUi,
      })}
    >
      {children}
    </RoleGate>
  )
}

// Instructor gate: instructor of this classroom (TAs excluded). An org owner is
// permitted only when they are on the classroom instructor team — org-admin
// status alone no longer grants classroom-instructor access (KTD-4).
const RequireInstructor = ({ children }: { children: ReactNode }) => {
  const { role, isLoading } = useClassroomRoleContext()
  return (
    <RoleGate
      resolved={!isLoading && role !== "unresolved"}
      permitted={can("editClassroomSettings", {
        classroomRole: role,
      })}
    >
      {children}
    </RoleGate>
  )
}

// Owner gate: org admin, read from the org-role context. Org-wide, independent
// of any classroom.
const RequireOwner = ({ children }: { children: ReactNode }) => {
  const { orgRole } = useOrgRole()
  return (
    <RoleGate
      resolved={orgRole !== "unresolved"}
      permitted={can("manageOrg", { orgRole })}
    >
      {children}
    </RoleGate>
  )
}

export default RequireTeacher
