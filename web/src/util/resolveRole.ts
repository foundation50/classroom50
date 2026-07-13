import { GitHubAPIError } from "@/hooks/github/errors"

// The viewer's effective role WITHIN a classroom, used by route guards and UI
// visibility. Precedence (highest first): instructor > ta > student. Org-admin
// status is NOT a classroom role — teams are classroom-specific, so an org
// owner not on THIS classroom's instructor team is not an instructor of it (see
// resolveClassroomRole). Org-wide capability lives in OrgRole instead.
// `unresolved` is a fail-closed sentinel: a needed signal hit a transient
// error, so callers treat it as "don't redirect; let the page load" rather than
// demoting a real staff member on a blip.
export type EffectiveRole = "instructor" | "ta" | "student" | "unresolved"

// The viewer's ORG-wide capability, independent of any classroom. `owner` (org
// admin) gates org settings, member management, and classroom creation.
// `unresolved` is the same fail-closed sentinel as EffectiveRole.
export type OrgRole = "owner" | "member" | "unresolved"

// A tri-state membership signal: definitively in / definitively out / couldn't
// tell (transient). Fail-closed: a blip reads as `unresolved`, never as a
// definitive verdict (see membershipFromQuery).
export type Membership = "member" | "non-member" | "unresolved"

// Structural inputs so the verdict is a pure, unit-testable function (no React
// Query). Each signal is pre-reduced to its tri-state.
export type ClassroomRoleInput = {
  org: string | undefined
  classroom: string | undefined
  // Per-classroom team memberships (instructor > ta > student precedence).
  instructor: Membership
  ta: Membership
  student: Membership
}

// Pure classroom role resolution from the three per-classroom teams
// (instructor > ta > student). A confirmed team member resolves positively; a
// definitive non-member of all three is a student (the safe default). Fail
// posture is asymmetric by design: a needed ELEVATION read (instructor/ta) that
// is still in flight yields `unresolved` (fail-closed — a transient blip must
// never demote a real staffer to student). The STUDENTS-team read is a safe
// signal that can only ever confirm the default role, never grant access, so an
// in-flight/errored students read does NOT hold — it falls through to the
// `student` default (fail-open-to-student), so a real student is never stranded
// on a spinner by a students-team blip. NOTE (KTD-4): org-admin status is NOT a
// classroom role — that capability is OrgRole, resolved at the org boundary.
export function resolveClassroomRole(input: ClassroomRoleInput): EffectiveRole {
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

// Reduce an org-membership read to the org-wide capability. An active admin is
// `owner`; a definitive non-admin (success non-admin, or 403/404) is `member`;
// anything in flight/transient is `unresolved` (fail-closed — never demote a
// real owner on a blip).
export function resolveOrgRole(input: {
  isSuccess: boolean
  role: string | undefined
  state: string | undefined
  error: unknown
}): OrgRole {
  const { isSuccess, role, state, error } = input
  if (state === "active" && role === "admin") return "owner"
  const definitiveNonOwner =
    isSuccess ||
    (error instanceof GitHubAPIError &&
      (error.status === 403 || error.status === 404))
  return definitiveNonOwner ? "member" : "unresolved"
}

// Whether a classroom role may see/do instructor-or-TA classroom content.
// `unresolved` is permissive on purpose: the guard treats it as "let the page
// load".
export function isStaffRole(role: EffectiveRole): boolean {
  return role === "instructor" || role === "ta" || role === "unresolved"
}

// Whether a classroom role may see/do instructor-only surfaces (classroom
// settings). TAs are excluded; `unresolved` is permissive (see isStaffRole).
export function isInstructorRole(role: EffectiveRole): boolean {
  return role === "instructor" || role === "unresolved"
}

// The roles an instructor can preview the app AS. A client-side lens for
// verifying what each role sees — never escalates.
export type ViewAsRole = "ta" | "student"

// Rank for the downgrade-only clamp. `unresolved` is intentionally absent — we
// never clamp an in-flight role (the guard is still showing a spinner).
const ROLE_RANK: Record<Exclude<EffectiveRole, "unresolved">, number> = {
  instructor: 2,
  ta: 1,
  student: 0,
}

// Apply a "view as" preview to an actual role. DOWNGRADE-ONLY: the preview can
// only lower the effective role, never raise it, so it can't be abused to gain
// access. `unresolved`/no-preview pass through unchanged.
export function applyViewAs(
  actual: EffectiveRole,
  viewAs: ViewAsRole | null,
): EffectiveRole {
  if (!viewAs || actual === "unresolved") return actual
  // Applies only when it ranks strictly below the actual role; else a no-op.
  return ROLE_RANK[viewAs] < ROLE_RANK[actual] ? viewAs : actual
}

// Translation key for the human role label: instructor => "nav.roleInstructor",
// ta => "nav.roleTa", student => "nav.roleStudent", unresolved => null (so
// callers show a skeleton mid-load). Pass through t().
export function roleLabelKey(role: EffectiveRole): string | null {
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
): Membership {
  if (isSuccess) return "member"
  if (error instanceof GitHubAPIError && error.status === 404) {
    return "non-member"
  }
  // Any other error (or no answer yet) is transient — don't demote.
  return "unresolved"
}

// The repo-query state the coarse staff verdict depends on. Structural so the
// verdict stays a pure, testable function (no React Query).
export type TeacherVerdictInput = {
  org: string | undefined
  isSuccess: boolean
  permissions?: {
    admin?: boolean
    maintain?: boolean
    push?: boolean
    pull?: boolean
  }
  error: unknown
}

export type TeacherVerdict = {
  isTeacher: boolean
  isStudent: boolean
  isBlocked: boolean
  roleResolved: boolean
  showTeacherUi: boolean
}

// Pure, fail-closed coarse role resolution against the org's `classroom50`
// config repo: teacher = repo GET succeeded with a non-trivial permission,
// student = 404, blocked = 403. Resolved only on a definitive verdict
// (success/404/403) — a transient 5xx/429/network error must NOT resolve, or a
// student during a blip would be promoted into teacher UI. Org-less routes have
// no role.
export function resolveTeacherVerdict(
  input: TeacherVerdictInput,
): TeacherVerdict {
  const { org, isSuccess, permissions, error } = input

  const isTeacher =
    isSuccess &&
    Boolean(
      permissions?.admin ||
      permissions?.maintain ||
      permissions?.push ||
      permissions?.pull,
    )

  const isStudent = error instanceof GitHubAPIError && error.status === 404
  const isBlocked = error instanceof GitHubAPIError && error.status === 403

  const roleResolved = !org || isSuccess || isStudent || isBlocked
  const showTeacherUi = Boolean(org) && isTeacher

  return { isTeacher, isStudent, isBlocked, roleResolved, showTeacherUi }
}
