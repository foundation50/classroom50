import type { EffectiveRole, OrgRole } from "@/util/resolveRole"

// The capability vocabulary — WHAT a viewer can do, decoupled from WHICH role
// they hold. Consumers ask `can("editClassroomSettings")` instead of comparing
// role literals, so a policy change lives in one place.
export type Capability =
  // Org-wide (org admin only).
  | "manageOrg" // org settings / members / activity
  | "createClassroom"
  // Org-scoped staff signal for surfaces with no classroom in scope (e.g. the
  // org "Published" page), backed by the config-repo verdict.
  | "viewOrgStaffContent"
  // Classroom-scoped.
  | "viewClassroomStaffContent" // roster / authoring / submissions (instructor|ta)
  | "editClassroomSettings" // instructor only
  | "previewAsRole" // the "view as" offer — instructor only
  | "claimInstructor" // org owner who currently resolves to student here

// The resolved signals a capability decision draws on. All optional: a
// classroom-scoped capability doesn't need `orgRole`, an org-scoped one doesn't
// need `classroomRole`. `classroomRole` is undefined off a classroom route;
// `orgStaff` is the org-scoped config-repo verdict for org-less surfaces.
export type CapabilityInput = {
  orgRole?: OrgRole
  classroomRole?: EffectiveRole
  orgStaff?: boolean
}

// Central policy: the single source of truth mapping roles to capabilities.
// Mirrors the semantics that were previously scattered as role-literal checks.
// Fail-closed and self-contained: an `unresolved` role is denied here (it does
// NOT rely on callers to separately gate the sentinel). Route guards still pair
// a `resolved` signal to decide spinner-vs-NotFound, but a consumer that reads
// `can(...)` alone (e.g. a nav affordance) can't be tricked into granting during
// the in-flight window.
export function can(cap: Capability, input: CapabilityInput): boolean {
  const { orgRole, classroomRole, orgStaff } = input
  switch (cap) {
    case "manageOrg":
    case "createClassroom":
      return orgRole === "owner"
    case "viewOrgStaffContent":
      return orgStaff === true
    case "viewClassroomStaffContent":
      return classroomRole === "instructor" || classroomRole === "ta"
    case "editClassroomSettings":
      return classroomRole === "instructor"
    case "previewAsRole":
      return classroomRole === "instructor"
    case "claimInstructor":
      return orgRole === "owner" && classroomRole === "student"
  }
}
