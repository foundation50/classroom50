import type { StaffRole } from "@/types/classroom"

// Single home for Classroom-50's role vocabulary and the app<->GitHub role
// mappings. There are exactly three concepts here — keep them distinct:
//
//   1. GitHubOrgRole      — the viewer's standing in the GitHub org
//                           (owner | member | non-member). Owner is the product
//                           name for GitHub's org `admin`.
//   2. ClassroomRole      — the viewer's in-app role within a classroom
//                           (instructor | ta | student), backed by GitHub teams.
//   3. GitHubTeamMembership — a low-level "is the viewer on THIS team?" probe
//                           result. It FEEDS classroom-role resolution but is not
//                           itself a role; "member" here means "on this team",
//                           NOT "in the org" (so it is not GitHubOrgRole).
//
// Each carries an `unresolved` fail-closed sentinel: a needed signal hit a
// transient error, so callers hold ("don't redirect / don't demote") rather than
// act on a blip. The one contract-frozen literal, StaffRole ("instructor"|"ta"),
// lives in types/classroom.ts (it mirrors the persisted `teams` schema shape);
// everything here derives from it, so adding a role (e.g. "head-ta") is: add the
// literal to StaffRole (the contract — also its schema + CLI mirror), then extend
// the maps below. The unions, rank, and slug role pick it up automatically.
//
// Product terms (instructor/ta/student, owner) are distinct from GitHub WIRE
// terms (team member/maintainer; org admin/direct_member); the two directions of
// the admin<->owner correspondence live only in this file (orgRoleForRole /
// roleForOrgRole).

// --- 1. GitHub org standing -------------------------------------------------

// The viewer's standing in the GitHub org, independent of any classroom. `owner`
// (the product name for GitHub's org `admin`) gates org settings, member
// management, and classroom creation; `member` is a confirmed non-owner member;
// `non-member` is a definitive outsider (403/404). `unresolved` is fail-closed —
// a transient blip, never demote a real owner.
export type GitHubOrgRole = "owner" | "member" | "non-member" | "unresolved"

// --- 2. Classroom role ------------------------------------------------------

// The sole non-staff classroom role. Named for symmetry with StaffRole so
// ClassroomRole reads as "student or staff".
export type StudentRole = "student"

// A person's role WITHIN a classroom: student (classroom team) or a StaffRole
// (instructor/ta staff teams). The single base the other classroom-role shapes
// derive from. A person can hold several (an instructor also on the student
// team), so roster rows carry a set of these.
export type ClassroomRole = StudentRole | StaffRole

// A resolved classroom role for guards/UI: the base plus the fail-closed
// sentinel. Precedence (highest first): instructor > ta > student. `unresolved`
// means "let the page load; don't redirect" rather than demoting a real staffer.
export type ResolvedRole = ClassroomRole | "unresolved"

// The roles an instructor can preview the app AS — a client-side lens that never
// escalates (see applyViewAs). Derived as ClassroomRole minus "instructor" so it
// can't drift: you can't preview as the top role.
export type ViewAsRole = Exclude<ClassroomRole, "instructor">

// Precedence for the primary badge / role sort and the view-as downgrade clamp:
// instructor > ta > student. One rank map for both roster presentation and the
// guard clamp.
export const ROLE_RANK: Record<ClassroomRole, number> = {
  instructor: 2,
  ta: 1,
  student: 0,
}

// Sort a role set by precedence (highest first). Pure; returns a new array.
export function sortRolesByRank(roles: ClassroomRole[]): ClassroomRole[] {
  return [...roles].sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])
}

// --- 3. Team-membership probe primitive -------------------------------------

// The result of a single "is the viewer on THIS team?" probe: definitively on /
// off / couldn't tell (transient). Fail-closed: a blip reads as `unresolved`,
// never a definitive verdict. Feeds ClassroomRole resolution (one probe per
// per-classroom staff/student team); "member" means "on this team".
export type GitHubTeamMembership = "member" | "non-member" | "unresolved"

// --- The app<->GitHub org-role mapping (both directions, single-sourced) -----
// Security-sensitive: this is the ONLY place "who becomes an org owner" is
// decided, so a missed hand-copy can't silently mis-scope admin access.

// WRITE: the GitHub org membership role an invite/role-change carries for a
// classroom role. An instructor becomes an org OWNER (wire "admin"); student/ta
// are plain members ("direct_member").
export function orgRoleForRole(role: ClassroomRole): "admin" | "direct_member" {
  return role === "instructor" ? "admin" : "direct_member"
}

// READ (inverse): the classroom role implied by an existing invitation's GitHub
// org role. "admin" grants org OWNER, i.e. an instructor; anything else
// re-invites as a plain student (org role alone can't distinguish TA from
// student, and student is the safe default a re-invite lands on).
export function roleForOrgRole(orgRole: string): ClassroomRole {
  return orgRole === "admin" ? "instructor" : "student"
}

// --- Backward-compatible aliases (deprecated) -------------------------------
// The names below were the pre-overhaul vocabulary. Kept so existing importers
// (and the resolveRole/teamRoster re-export surfaces) don't churn in this PR;
// remove in a follow-up repoint pass.

/** @deprecated Use GitHubOrgRole. */
export type OrgRole = GitHubOrgRole
/** @deprecated Use GitHubTeamMembership. */
export type Membership = GitHubTeamMembership
/** @deprecated Use ClassroomRole. */
export type RosterRole = ClassroomRole
/** @deprecated Use ResolvedRole. */
export type EffectiveRole = ResolvedRole
