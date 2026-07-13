import { useParams } from "@tanstack/react-router"
import { useOrgRole } from "@/context/orgRole/OrgRoleProvider"
import { useClassroomRoleContextOptional } from "@/context/classroomRole/ClassroomRoleProvider"
import { useConfigRepoAccess } from "@/hooks/useConfigRepoAccess"
import { can, type Capability, type CapabilityInput } from "@/util/capabilities"

// React binding for the capability policy: assembles the resolved org + (when
// under a classroom) classroom role, plus the org-scoped staff verdict for
// org-less surfaces, then exposes `can(capability)`. `resolved` tells a caller
// whether the signals a capability depends on have settled, so a guard can hold
// a spinner rather than deny prematurely (fail-closed). Resolution still happens
// ONCE per boundary in the providers; this only reads their context.
export function useCapabilities(): {
  can: (cap: Capability) => boolean
  resolved: boolean
} {
  const { org, classroom } = useParams({ strict: false })
  const { orgRole } = useOrgRole()
  const classroomCtx = useClassroomRoleContextOptional()
  // Org-scoped staff verdict is only needed off a classroom (e.g. Published).
  // On a classroom route the classroom context is authoritative.
  const orgStaffAccess = useConfigRepoAccess(classroom ? undefined : org)

  const input: CapabilityInput = {
    orgRole,
    classroomRole: classroomCtx?.role,
    orgStaff: orgStaffAccess.showTeacherUi,
  }

  // Resolved when the org role has settled and, if under a classroom, its role
  // has too. The org-staff verdict carries its own `roleResolved` for org-less
  // staff gates.
  const resolved =
    orgRole !== "unresolved" &&
    (classroom ? classroomCtx?.roleResolved === true : true)

  return {
    can: (cap: Capability) => can(cap, input),
    resolved,
  }
}
