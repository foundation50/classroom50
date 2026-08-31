import { CONFIG_REPO } from "@/util/configRepo"
import { STAFF_ROLES, type StaffRole, type Classroom } from "@/types/classroom"

// Roles a per-classroom team can back. Broader than StaffRole: also the students
// team, a real team but not a staff role (no `-<role>` suffix, absent from
// classroom.json.teams). Layered on StaffRole so the head-ta role flows in free.
export type ClassroomTeamRole = "student" | StaffRole

// The single derivation of a per-classroom team's slug (== name, given the
// canonical-short-name guard). Student drops the role suffix
// (`classroom50-<classroom>`); each staff role appends it
// (`classroom50-<classroom>-<role>`). A byte-mirror of the CLI/schema team
// convention — a cross-tool contract with no compile-time link across Go and
// TypeScript, so keep it in lockstep.
//
// Safe-degrade for students: the authoritative slug lives in the private
// classroom.json a student can't read, so a student derives it. On a slug
// collision the derived slug 404s and the membership read reports "not a
// member", so a miss never grants false access; the teacher side reads the real
// slug from classroom.json.
export function classroomTeamSlug(
  classroom: string,
  role: ClassroomTeamRole = "student",
): string {
  return role === "student"
    ? `${CONFIG_REPO}-${classroom}`
    : `${CONFIG_REPO}-${classroom}-${role}`
}

// The full set of team slugs whose active membership means a user is enrolled
// in a classroom: the student team plus every staff team.
// Single-sources the "is enrolled?" slug enumeration — the accept gate (the
// self-scoped enrollment probe and the accept-flow guard) derives its slugs
// here rather than re-listing roles, so a role change can't drift the gate.
// Ordered student-first so a caller can short-circuit on the common case.
// Byte-mirrors the CLI's contract.ClassroomTeamSlugs — keep in lockstep.
export function classroomTeamSlugs(classroom: string): string[] {
  return [
    classroomTeamSlug(classroom),
    ...STAFF_ROLES.map((role) => classroomTeamSlug(classroom, role)),
  ]
}

// The authoritative per-classroom team slug for a role, preferring the slug
// GitHub actually assigned (stored in classroom.json — GitHub can rewrite a slug
// on a name collision) and falling back to the derived classroomTeamSlug when
// the classroom.json ref is absent (a pre-feature classroom, or a teacher who
// hasn't loaded classroom.json yet). Owner surfaces (roster view + Settings
// staff section) resolve slugs through here so they can't target different teams
// for the same role.
export function resolveClassroomRoleSlug(
  classroom: string,
  role: ClassroomTeamRole,
  refs: Pick<Classroom, "team" | "teams"> | undefined,
): string {
  if (role === "student") {
    return refs?.team?.slug || classroomTeamSlug(classroom, "student")
  }
  if (role === "teacher") {
    return refs?.teams?.teacher?.slug || classroomTeamSlug(classroom, "teacher")
  }
  return refs?.teams?.[role]?.slug || classroomTeamSlug(classroom, role)
}

// Inverse of classroomTeamSlug for a STAFF team: parse a team slug back to its
// { classroom, role } when it is a
// `classroom50-<classroom>-<teacher|hta|ta>` team, else null. Used to
// derive an org-level staff signal from the viewer's own team memberships
// (GET /user/teams) without reading the config repo.
//
// A classroom short-name may contain hyphens (e.g., `cs-principles`), so match a
// known role SUFFIX first, then take the middle as the classroom — never split
// naively on `-`. Only staff roles are recognized: a bare student slug
// (`classroom50-<classroom>`, no role suffix) returns null, since the student
// team is not a staff signal. A non-classroom slug returns null.
export function parseClassroomTeamSlug(
  slug: string,
): { classroom: string; role: StaffRole } | null {
  const prefix = `${CONFIG_REPO}-`
  if (!slug.startsWith(prefix)) return null
  for (const role of STAFF_ROLES) {
    const suffix = `-${role}`
    if (slug.endsWith(suffix)) {
      // Everything between the prefix and the role suffix is the classroom.
      const classroom = slug.slice(prefix.length, slug.length - suffix.length)
      // A non-empty classroom is required (guards `classroom50-teacher`,
      // which has no classroom segment and isn't a real per-classroom team).
      if (classroom.length > 0) return { classroom, role }
    }
  }
  return null
}

// Inverse of classroomTeamSlug for the STUDENT team: parse a bare
// `classroom50-<classroom>` slug (no role suffix) back to its classroom, else
// null. Used to enumerate a student's classrooms from GET /user/teams without
// reading the config repo. Deliberately the complement of parseClassroomTeamSlug
// (staff-only): a slug ending in a known staff-role suffix returns null here so
// a staff team is never mistaken for a student membership. `classroom50` alone
// (no classroom segment) returns null.
export function parseStudentClassroomSlug(
  slug: string,
): { classroom: string } | null {
  // A staff slug is not a student team — let parseClassroomTeamSlug own those.
  if (parseClassroomTeamSlug(slug)) return null
  return parseBareClassroomSlug(slug)
}

// Extract the whole post-prefix segment as the classroom, WITHOUT the staff-role
// exclusion parseStudentClassroomSlug applies. Used only to resolve the ambiguous
// case where a slug parses as staff (`classroom50-ml-ta`) yet is really the
// student team of a role-suffixed classroom (`ml-ta`) — proven by a
// classroom50/team/v1 record on the team (staff teams carry none). The caller
// gates on that record; on its own this does not distinguish student from staff.
export function parseBareClassroomSlug(
  slug: string,
): { classroom: string } | null {
  const prefix = `${CONFIG_REPO}-`
  if (!slug.startsWith(prefix)) return null
  const classroom = slug.slice(prefix.length)
  if (classroom.length === 0) return null
  return { classroom }
}

// ---------------------------------------------------------------------------
// Per-assignment group teams (mode: team assignments)
// ---------------------------------------------------------------------------

// Team-name prefix for a per-assignment group team:
// `classroom50-group-<hash>-<n>`. Living inside the `classroom50-` namespace
// keeps group teams behind the same fail-closed delete guard as the classroom
// teams (isDeletableClassroomTeamRef). A byte-mirror of
// contract.GroupTeamPrefix (cli/shared/contract) with no compile-time link —
// keep in lockstep; both sides pin the shared vectors in
// cli/shared/testdata/group_vectors.json.
export const GROUP_TEAM_PREFIX = `${CONFIG_REPO}-group-`

// SHA-256 prefix length (hex chars) in the group team name. 16 hex = 64 bits —
// ample collision resistance for per-assignment scoping. Mirror of
// contract.GroupHashHexLen.
export const GROUP_HASH_HEX_LEN = 16

// The FULL group-team shape destructive ops must gate on (plus a parsed
// classroom50/group/v1 description record plus a recorded-vs-live id check):
// the prefix alone is a namespace a pathological classroom short-name could
// land in. Mirror of contract.GroupTeamPattern.
export const GROUP_TEAM_PATTERN = /^classroom50-group-[0-9a-f]{16}-[1-9][0-9]*$/

// The deterministic hex prefix scoping one assignment's group teams: the first
// GROUP_HASH_HEX_LEN hex chars of SHA-256 over
// `<lowercased classroom>\0<lowercased assignment>`. The separator byte
// prevents ("ab","c") and ("a","bc") colliding; lowercasing mirrors
// studentRepoName so a mixed-case input can't split one assignment's teams
// into two namespaces. Async because it uses the Web Crypto digest (mirrors
// inviteTeamName). Byte-mirror of contract.GroupTeamHash.
export async function groupTeamHash(
  classroom: string,
  assignment: string,
): Promise<string> {
  const encoded = new TextEncoder().encode(
    `${classroom.toLowerCase()}\u0000${assignment.toLowerCase()}`,
  )
  const digest = await crypto.subtle.digest("SHA-256", encoded)
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return hex.slice(0, GROUP_HASH_HEX_LEN)
}

// The enumeration prefix for one assignment's group teams:
// `classroom50-group-<hash>-`. Filtering GET /orgs/{org}/teams (or GET
// /user/teams) on it yields exactly this assignment's teams — no config read
// needed, which is what lets a student client resolve "my team" from
// membership alone. Byte-mirror of contract.GroupTeamAssignmentPrefix.
export async function groupTeamAssignmentPrefix(
  classroom: string,
  assignment: string,
): Promise<string> {
  return `${GROUP_TEAM_PREFIX}${await groupTeamHash(classroom, assignment)}-`
}

// The canonical group-team NAME (== slug: the name is slug-safe by
// construction, so GitHub's name-to-slug generation is the identity function)
// for counter n. Counters start at 1 and are allocated by create-time 422
// retries, never by visibility-dependent probes (a secret team is invisible to
// non-members, so a listing can't prove a counter free). Byte-mirror of
// contract.GroupTeamName.
export async function groupTeamName(
  classroom: string,
  assignment: string,
  n: number,
): Promise<string> {
  return `${await groupTeamAssignmentPrefix(classroom, assignment)}${n}`
}

// True when a slug matches the FULL group-team shape. See GROUP_TEAM_PATTERN
// for what a destructive caller must additionally verify.
export function isGroupTeamSlug(slug: string): boolean {
  return GROUP_TEAM_PATTERN.test(slug)
}

// Recover the counter from a group-team slug given that assignment's
// enumeration prefix (from groupTeamAssignmentPrefix), or null when the slug
// isn't one of that assignment's teams. The hash is one-way, so a slug alone
// (unknown assignment) is attributed via its description record instead.
export function parseGroupTeamCounter(
  slug: string,
  assignmentPrefix: string,
): number | null {
  if (!slug.startsWith(assignmentPrefix) || !isGroupTeamSlug(slug)) return null
  const n = Number(slug.slice(assignmentPrefix.length))
  return Number.isInteger(n) && n >= 1 ? n : null
}
