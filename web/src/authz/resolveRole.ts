import { GitHubAPIError } from "@/github-core/errors"
import type {
  ResolvedRole,
  GitHubOrgRole,
  GitHubTeamMembership,
  ViewAsRole,
} from "./roles"
import { ROLE_RANK } from "./roles"

// Role types are single-sourced in ./roles; re-exported here because the
// resolution logic below is their primary consumer and guards/UI reach for the
// type alongside these resolvers.
export type { ResolvedRole, GitHubOrgRole, GitHubTeamMembership, ViewAsRole }

// Structural inputs so the verdict is a pure, unit-testable function (no React
// Query). Each signal is pre-reduced to its tri-state.
export type ClassroomRoleInput = {
  org: string | undefined
  classroom: string | undefined
  // Per-classroom team memberships (instructor > ta > student precedence).
  instructor: GitHubTeamMembership
  ta: GitHubTeamMembership
  student: GitHubTeamMembership
}

// Pure classroom role from the three per-classroom teams (instructor > ta >
// student). Fail posture is asymmetric: an in-flight ELEVATION read holds
// (`unresolved`, fail-closed); an in-flight students read can't grant access so
// it falls through to the safe `student` default (fail-open). See inline notes.
export function resolveClassroomRole(input: ClassroomRoleInput): ResolvedRole {
  const { org, classroom, instructor, ta, student } = input

  if (!org || !classroom) return "student"

  // A confirmed membership is definitive and resolves immediately, highest
  // precedence first — so a confirmed instructor isn't held on a slower ta/
  // student read.
  if (instructor === "member") return "instructor"
  if (ta === "member") return "ta"
  if (student === "member") return "student"

  // No confirmed membership. Only the ELEVATION reads gate: if an instructor or
  // ta read is still in flight, hold rather than demote a real staffer. The
  // students-team read is intentionally NOT a gate (it can't grant access), so
  // its being unresolved falls through to the student default below.
  if (instructor === "unresolved" || ta === "unresolved") {
    return "unresolved"
  }

  // Instructor and ta are definitive non-member — no path to elevated access —
  // so the viewer is a student (whether their students-team read confirmed
  // membership, 404'd, or errored). Safe default.
  return "student"
}

// Reduce an org-membership read to the viewer's org standing. An active admin is
// `owner`; a successful read of a non-admin active membership is `member`; a
// definitive 403/404 is `non-member` (outsider); anything in flight/transient is
// `unresolved` (fail-closed — never demote a real owner on a blip).
export function resolveOrgRole(input: {
  isSuccess: boolean
  role: string | undefined
  state: string | undefined
  error: unknown
}): GitHubOrgRole {
  const { isSuccess, role, state, error } = input
  if (state === "active" && role === "admin") return "owner"
  if (isSuccess) return "member"
  if (
    error instanceof GitHubAPIError &&
    (error.isForbidden || error.isNotFound)
  )
    return "non-member"
  return "unresolved"
}

// Apply a "view as" preview to an actual role. DOWNGRADE-ONLY: the preview can
// only lower the effective role, never raise it, so it can't be abused to gain
// access. `unresolved`/no-preview pass through unchanged.
export function applyViewAs(
  actual: ResolvedRole,
  viewAs: ViewAsRole | null,
): ResolvedRole {
  if (!viewAs || actual === "unresolved") return actual
  // Applies only when it ranks strictly below the actual role; else a no-op.
  return ROLE_RANK[viewAs] < ROLE_RANK[actual] ? viewAs : actual
}

// Translation key for the human role label; null while `unresolved` so callers
// show a skeleton mid-load. Pass through t().
export function roleLabelKey(role: ResolvedRole): string | null {
  switch (role) {
    case "instructor":
      return "nav.roleInstructor"
    case "ta":
      return "nav.roleTa"
    case "student":
      return "nav.roleStudent"
    case "unresolved":
      return null
  }
}

// Reduce a team-membership query (404 => non-member, other error => unresolved)
// to the tri-state, so a blip never demotes a real staff member.
export function membershipFromQuery(
  isSuccess: boolean,
  error: unknown,
): GitHubTeamMembership {
  if (isSuccess) return "member"
  if (error instanceof GitHubAPIError && error.isNotFound) {
    return "non-member"
  }
  // Any other error (or no answer yet) is transient — don't demote.
  return "unresolved"
}

// --- Org-level staff verdict (team-based) -----------------------------------

// The viewer's org-level staff standing for surfaces with NO classroom in scope
// (Published page, "My Classes" nav, ClassesPage): staff = confirmed member of
// >=1 classroom staff team in the org, derived from the viewer's own team
// memberships (see useOrgStaff). Fail-closed tri-state: a transient/in-flight
// read holds `unresolved` rather than demoting a real staffer. This pure verdict
// is team-only; useOrgStaff additionally grants staff to an org owner (so a
// freshly-configured org with no teams isn't stranded) — owner precedence lives
// in the hook, not this type.
export type OrgStaffVerdict = {
  isStaff: boolean
  // Definitively-resolved AND not staff — the org-less "treat as a plain member/
  // student" signal the footer + ClassesPage read. Never true while unresolved.
  isNonStaff: boolean
  roleResolved: boolean
}
