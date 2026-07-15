import { CONFIG_REPO } from "@/util/configRepo"
import { STAFF_ROLES, type StaffRole } from "@/types/classroom"

// Roles a per-classroom team can back. Broader than StaffRole: also the students
// team, a real team but not a staff role (no `-<role>` suffix, absent from
// classroom.json.teams). Layered on StaffRole so a future head-ta flows in free.
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

// Inverse of classroomTeamSlug for a STAFF team: parse a team slug back to its
// { classroom, role } when it is a `classroom50-<classroom>-<instructor|ta>`
// team, else null. Used to derive an org-level staff signal from the viewer's
// own team memberships (GET /user/teams) without reading the config repo.
//
// A classroom short-name may contain hyphens (e.g. `cs-principles`), so match a
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
      // A non-empty classroom is required (guards `classroom50-instructor`,
      // which has no classroom segment and isn't a real per-classroom team).
      if (classroom.length > 0) return { classroom, role }
    }
  }
  return null
}
