import type { StaffRole } from "@/types/classroom"

// Single home for Classroom-50's role vocabulary and the app<->GitHub role
// mappings. Three concepts, each in its own section below: GitHubOrgRole (org
// standing), ClassroomRole (in-app role), and GitHubTeamMembership (a per-team
// probe result that feeds ClassroomRole). Every union derives from the
// contract-frozen StaffRole (types/classroom.ts, mirroring the persisted `teams`
// schema), so adding a role starts there.

// --- 1. GitHub org standing -------------------------------------------------

// The viewer's standing in the GitHub org, independent of any classroom. `owner`
// (the product name for GitHub's org `admin`) gates org settings, member
// management, and classroom creation; `member` is a confirmed non-owner member;
// `non-member` is a definitive outsider (403/404). `unresolved` is fail-closed —
// a transient blip, never demote a real owner.
export type GitHubOrgRole = "owner" | "member" | "non-member" | "unresolved"

// --- 2. Classroom role ------------------------------------------------------

// The sole non-staff classroom role. Internal — a building block for the public
// ClassroomRole below.
type StudentRole = "student"

// A person's role WITHIN a classroom: student (classroom team) or a StaffRole
// (teacher/ta staff teams; `instructor` is the legacy alias of teacher). The
// single base the other classroom-role shapes derive from. A person can hold
// several (a teacher also on the student team), so roster rows carry a set of
// these.
export type ClassroomRole = StudentRole | StaffRole

// A resolved classroom role for guards/UI: the base plus the fail-closed
// sentinel. Precedence (highest first): teacher > hta > ta > student.
// `unresolved` means "let the page load; don't redirect" rather than demoting a
// real staffer.
export type ResolvedRole = ClassroomRole | "unresolved"

// The roles a teacher can preview the app AS — a client-side lens that never
// escalates (see applyViewAs). Derived as ClassroomRole minus the top staff
// roles so it can't drift: you can't preview as the top role.
export type ViewAsRole = Exclude<ClassroomRole, "teacher" | "instructor">

// Role precedence (teacher > hta > ta > student), shared by the primary-badge/
// roster sort and the view-as downgrade clamp so the two can't disagree. The
// legacy `instructor` alias shares the teacher rank.
export const ROLE_RANK: Record<ClassroomRole, number> = {
  teacher: 3,
  instructor: 3,
  hta: 2,
  ta: 1,
  student: 0,
}

export function sortRolesByRank(roles: ClassroomRole[]): ClassroomRole[] {
  return [...roles].sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])
}

// The single predicate for "is this the top staff role" — the canonical
// `teacher` or its legacy `instructor` alias. Lives here (the leaf role-
// vocabulary module) so every consumer — capabilities, resolution, role
// writes, roster preflight — shares one definition and can't drift on the two
// names during the rename migration. When the alias is retired, this is the
// one place the `instructor` arm is dropped.
export function isTeacherRole(role: ResolvedRole | undefined): boolean {
  return role === "teacher" || role === "instructor"
}

// --- 3. Team-membership probe primitive -------------------------------------

// The result of a single "is the viewer on THIS team?" probe: definitively on /
// off / couldn't tell (transient). Fail-closed: a blip reads as `unresolved`,
// never a definitive verdict. Feeds ClassroomRole resolution (one probe per
// per-classroom staff/student team); "member" means "on this team".
export type GitHubTeamMembership = "member" | "non-member" | "unresolved"

// --- The app<->GitHub org-role mapping (both directions, single-sourced) -----
// The ONLY place the admin<->owner correspondence is decided (GitHub wire
// "admin" == product "owner", i.e. teacher). Security-sensitive: a missed
// hand-copy elsewhere could silently mis-scope owner access, so all three
// helpers below live here.

// WRITE: the org membership role an invite/role-change carries. Only teacher
// (and its legacy `instructor` alias) maps to owner ("admin"); student/ta are
// "direct_member".
export function githubOrgRoleForRole(
  role: ClassroomRole,
): "admin" | "direct_member" {
  return isTeacherRole(role) ? "admin" : "direct_member"
}

// READ (inverse): the classroom role an existing invite's org role implies.
// Anything but "admin" re-invites as a plain student — org role alone can't tell
// TA from student, and student is the safe default.
export function roleForGitHubOrgRole(githubOrgRole: string): ClassroomRole {
  return githubOrgRole === "admin" ? "teacher" : "student"
}

// The wire-level owner test, for callers holding a raw membership/invite payload
// (a pending invite, a per-org summary) that never reaches the provider. For a
// resolved viewer role, use resolveOrgRole / can("manageOrg") instead.
export function isOwnerGitHubOrgRole(githubOrgRole: string): boolean {
  return githubOrgRole === "admin"
}
