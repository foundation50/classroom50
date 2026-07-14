import { CONFIG_REPO } from "@/util/configRepo"
import type { StaffRole } from "@/types/classroom"

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
