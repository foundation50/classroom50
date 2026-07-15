import type { StaffRole } from "@/types/classroom"

// Single home for Classroom-50's role vocabulary and the app<->GitHub role
// mappings. Three distinct concepts live below, each in its own section:
// GitHubOrgRole (org standing), ClassroomRole (in-app role), and
// GitHubTeamMembership (a per-team probe result that feeds ClassroomRole).
// Every union derives from the one contract-frozen literal StaffRole (in
// types/classroom.ts, mirroring the persisted `teams` schema), so adding a role
// starts there. The admin<->owner correspondence lives only here
// (githubOrgRoleForRole / roleForGitHubOrgRole).

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
export function githubOrgRoleForRole(
  role: ClassroomRole,
): "admin" | "direct_member" {
  return role === "instructor" ? "admin" : "direct_member"
}

// READ (inverse): the classroom role implied by an existing invitation's GitHub
// org role. "admin" grants org OWNER, i.e. an instructor; anything else
// re-invites as a plain student (org role alone can't distinguish TA from
// student, and student is the safe default a re-invite lands on).
export function roleForGitHubOrgRole(githubOrgRole: string): ClassroomRole {
  return githubOrgRole === "admin" ? "instructor" : "student"
}
