import { can } from "@/authz"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import { useIsOrgOwner } from "@/context/githubOrgRole/useIsOrgOwner"

// What the viewer may do on a classroom's staff pages, derived once so every
// surface (toolbar, actions menu, row actions, table) reads the same verdicts
// instead of re-deriving them from the role in six places.
//
// Two tiers. Workflow dispatches (Collect now, Regrade all, per-row regrade,
// lock, delete) POST to the config repo's Actions API, which needs `push`
// there: the teacher and head-TA teams have it, a TA has `pull` and would 403.
// `authorAssignments` is exactly that write tier. Org ownership gates only what
// needs repo ADMIN (bulk access/features/visibility, Open all PRs, the template
// grant). Reading student repos needs neither: the overlays run for every staff
// viewer with the VIEWER's token, and a repo they lack access to reads as 404,
// which the fan-outs already treat as "not accepted". GitHub is the real
// enforcer; these are the UX gates.
export type StaffCapabilities = {
  isOwner: boolean
  // Whether the org repo list covers every repo. A non-owner sees only the
  // repos their staff team was granted, so acceptance derived from it is a
  // lower bound. Asserted while the role is still resolving: a confirmed owner
  // would otherwise flash the non-owner "you can see" wording on every load.
  acceptanceComplete: boolean
  canDispatchWorkflows: boolean
  canRegradeAll: boolean
  canChangeVisibility: boolean
}

export function useStaffCapabilities(): StaffCapabilities {
  const { role: classroomRole } = useClassroomRoleContext()
  const { isOwner, isPending: ownerPending } = useIsOrgOwner()
  const canDispatchWorkflows = can("authorAssignments", { classroomRole })
  return {
    isOwner,
    acceptanceComplete: isOwner || ownerPending,
    canDispatchWorkflows,
    canRegradeAll: canDispatchWorkflows,
    canChangeVisibility: isOwner,
  }
}
