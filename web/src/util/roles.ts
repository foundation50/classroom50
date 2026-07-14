import type { StaffRole } from "@/types/classroom"

// Single home for Classroom-50's PRODUCT role vocabulary and the app<->GitHub
// role mappings. The one contract-frozen literal — `StaffRole`
// ("instructor"|"ta") — stays in types/classroom.ts because it mirrors the
// persisted `teams` schema shape; everything derived from it lives here. Adding
// a role (e.g. "head-ta") is then: add the literal to StaffRole (the contract),
// then extend the maps below — the unions, rank, and slug role pick it up.
//
// Product terms (instructor/ta/student, owner) are distinct from GitHub WIRE
// terms (team member/maintainer; org admin/direct_member). The two directions of
// the admin<->owner correspondence are the only place that mapping lives.

// A person's classroom role(s). "student" = classroom team; instructor/ta = the
// per-classroom staff teams. A row can carry several (an instructor also on the
// student team), unioned across teams.
export type RosterRole = StaffRole | "student"

// The role suffix in a per-classroom team slug: `classroom50-<classroom>` for
// "student", `classroom50-<classroom>-<role>` for staff. Same set as RosterRole;
// named distinctly for the slug-building call site.
export type ClassroomTeamRole = "student" | StaffRole

// The viewer's effective role WITHIN a classroom (route guards + UI visibility).
// Precedence (highest first): instructor > ta > student. `unresolved` is a
// fail-closed sentinel: a needed signal hit a transient error, so callers treat
// it as "don't redirect; let the page load" rather than demoting a real staffer.
export type EffectiveRole = RosterRole | "unresolved"

// The viewer's ORG-wide capability, independent of any classroom. `owner` (the
// product name for GitHub's org `admin`) gates org settings, member management,
// and classroom creation. `unresolved` is the same fail-closed sentinel.
export type OrgRole = "owner" | "member" | "unresolved"

// A tri-state membership signal: definitively in / out / couldn't tell
// (transient). Fail-closed: a blip reads as `unresolved`, never definitive.
export type Membership = "member" | "non-member" | "unresolved"

// The roles an instructor can preview the app AS. A client-side lens; never
// escalates (see applyViewAs).
export type ViewAsRole = "ta" | "student"

// Precedence for the primary badge / role sort and the view-as downgrade clamp:
// instructor > ta > student. One rank map for both the roster presentation and
// the guard clamp (previously duplicated across teamRoster + resolveRole).
export const ROLE_RANK: Record<RosterRole, number> = {
  instructor: 2,
  ta: 1,
  student: 0,
}

// Sort a role set by precedence (highest first). Pure; returns a new array.
export function sortRolesByRank(roles: RosterRole[]): RosterRole[] {
  return [...roles].sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])
}

// --- The app<->GitHub org-role mapping (both directions, single-sourced) ---
// Security-sensitive: this is the ONLY place "who becomes an org owner" is
// decided, so a missed hand-copy can't silently mis-scope admin access.

// WRITE: the GitHub org membership role an invite/role-change carries for a
// classroom role. An instructor becomes an org OWNER (wire "admin"); student/ta
// are plain members ("direct_member").
export function orgRoleForRole(role: RosterRole): "admin" | "direct_member" {
  return role === "instructor" ? "admin" : "direct_member"
}

// READ (inverse): the classroom role implied by an existing invitation's GitHub
// org role. "admin" grants org OWNER, i.e. an instructor; anything else
// re-invites as a plain student (org role alone can't distinguish TA from
// student, and student is the safe default a re-invite lands on).
export function roleForOrgRole(orgRole: string): RosterRole {
  return orgRole === "admin" ? "instructor" : "student"
}
