import type { ResolvedRole, GitHubOrgRole } from "./resolveRole"
import { isTeacherRole } from "./roles"

// The capability vocabulary — WHAT a viewer can do, decoupled from WHICH role
// they hold. Consumers ask `can("editClassroomSettings")` instead of comparing
// role literals, so a policy change lives in one place.
export type Capability =
  // Org-wide (org admin only).
  | "manageOrg" // org settings / members / activity
  // Org-scoped staff signal for surfaces with no classroom in scope (e.g. the
  // org "Published" page), backed by the team-based "staff of any classroom"
  // signal (member of >=1 classroom staff team).
  | "viewOrgStaffContent"
  // Classroom-scoped.
  | "viewClassroomStaffContent" // roster / authoring / submissions (teacher|hta|ta)
  | "editClassroomSettings" // teacher only
  | "previewAsRole" // the "view as" offer — teacher only
  | "claimTeacher" // org owner who currently resolves to student here

// The resolved signals a capability decision draws on. All optional: a
// classroom-scoped capability doesn't need `githubOrgRole`, an org-scoped one
// doesn't need `classroomRole`. `classroomRole` is undefined off a classroom
// route; `orgStaff` is the org-scoped team-based staff signal for org-less
// surfaces.
export type CapabilityInput = {
  githubOrgRole?: GitHubOrgRole
  classroomRole?: ResolvedRole
  orgStaff?: boolean
}

// Central policy: the single source of truth mapping roles to capabilities.
// Fail-closed and self-contained: an `unresolved` role is denied here (it does
// NOT rely on callers to separately gate the sentinel). Route guards still pair
// a `resolved` signal to decide spinner-vs-NotFound, but a consumer that reads
// `can(...)` alone (e.g. a nav affordance) can't be tricked into granting during
// the in-flight window.
export function can(cap: Capability, input: CapabilityInput): boolean {
  const { githubOrgRole, classroomRole, orgStaff } = input
  switch (cap) {
    case "manageOrg":
      return githubOrgRole === "owner"
    case "viewOrgStaffContent":
      return orgStaff === true
    case "viewClassroomStaffContent":
      return (
        isTeacherRole(classroomRole) ||
        classroomRole === "hta" ||
        classroomRole === "ta"
      )
    case "editClassroomSettings":
      return isTeacherRole(classroomRole)
    case "previewAsRole":
      return isTeacherRole(classroomRole)
    case "claimTeacher":
      return githubOrgRole === "owner" && classroomRole === "student"
  }
}
