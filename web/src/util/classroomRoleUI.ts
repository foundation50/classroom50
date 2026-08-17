import type { BadgeTone } from "@/types/badgeTone"
import { ROLE_RANK, sortRolesByRank, type ClassroomRole } from "@/authz"
import type { StaffRole } from "@/types/classroom"
import type { TeamRosterRow, TeamRosterRowState } from "@/util/teamRoster"
import type { MetadataField } from "@/util/rosterMetadataMerge"

// Single source of truth for how a classroom role is presented and ranked.
// Shared by the Roster view and the classroom Settings staff section so the two
// surfaces can't drift on tone or precedence.
// ROLE_RANK and sortRolesByRank are single-sourced in the authz module and
// re-exported here so UI callers have one import for all role presentation.
export { ROLE_RANK, sortRolesByRank }

// i18n key per role for row badges and filter labels.
export const ROLE_LABEL_KEY: Record<ClassroomRole, string> = {
  teacher: "students.roleTeacher",
  hta: "students.roleHeadTa",
  ta: "students.roleTa",
  student: "students.roleStudent",
}

// Badge tone per role, distinct from the warning/error status tones so role and
// enrollment state read as separate facets. `student` uses the neutral ghost
// chip (rendered with the Badge `ghost` prop), so it maps to "neutral" here.
export const ROLE_BADGE_TONE: Record<ClassroomRole, BadgeTone> = {
  teacher: "primary",
  hta: "info",
  ta: "secondary",
  student: "neutral",
}

// Plural label + short access hint per staff role, used by the Settings staff
// section's per-role columns. Staff-only (no student) — the roster view renders
// singular chips via ROLE_LABEL_KEY and doesn't need these. Kept here beside the
// other role-presentation maps so the two surfaces can't drift on role copy.
export const ROLE_PLURAL_KEY: Record<StaffRole, string> = {
  teacher: "classes.staff.roleTeacherPlural",
  hta: "classes.staff.roleHeadTaPlural",
  ta: "classes.staff.roleTaPlural",
}

export const ROLE_ACCESS_KEY: Record<StaffRole, string> = {
  teacher: "classes.staff.accessTeacher",
  hta: "classes.staff.accessHeadTa",
  ta: "classes.staff.accessTa",
}

// Enrollment-state badge tone + i18n label, single-sourced so the roster row
// list (EnrolledStudents) and the member modal (RosterMemberModal) render the
// same status chip (they were hand-synced before and drifted once on a renamed
// key).
export const STATE_BADGE_TONE: Record<TeamRosterRowState, BadgeTone> = {
  enrolled: "success",
  pending: "warning",
  needs_attention_in_org: "warning",
  needs_attention_not_in_org: "error",
}

export const STATE_LABEL_KEY: Record<TeamRosterRowState, string> = {
  enrolled: "students.statusEnrolled",
  pending: "students.statusPending",
  needs_attention_in_org: "students.statusNeedsAttentionInOrg",
  needs_attention_not_in_org: "students.statusNeedsAttentionNotInOrg",
}

// i18n label key per updatable roster metadata field, used by the CSV import
// preview's per-cell change tooltip. Kept here beside the other label maps so
// the field->label mapping has one home rather than living inline in a page.
export const METADATA_FIELD_LABEL_KEY: Record<MetadataField, string> = {
  first_name: "students.firstNameColumn",
  last_name: "students.lastNameColumn",
  email: "students.emailColumn",
  section: "students.sectionColumn",
}

// Whether a row carries a student enrollment (a roster.csv row + student-team
// membership). True for a plain student AND for a student who is also staff.
// The single definition of "can be unenrolled": unenroll drops only the student
// enrollment (CSV row + student-team membership), leaving any staff role intact,
// so it applies to anyone with a student role — shared by the row modal's
// unenroll gate and the bulk-select gate so the two can't diverge (a
// student+teacher must be offered unenroll in BOTH surfaces, never one).
export function hasStudentEnrollment(
  row: Pick<TeamRosterRow, "roles">,
): boolean {
  return row.roles.includes("student")
}

// Whether unenroll can actually target this row's roster entry. The shared
// roster-row matcher identifies a row by username or github_id only (a shared
// email must never widen a removal), so a row carrying NEITHER — a pending
// email invite, whose address is all we know until the student accepts — has
// nothing for unenroll to match and would fail with "does not exist in roster".
//
// Such a row is retired by CANCELLING the invitation instead, which is also the
// only correct action: dropping the roster row alone would leave the invitation
// live, so the student could still accept and land in the classroom. Cancelling
// revokes it, deletes the stored email, and the reconcile then drops the row.
export function canTargetForUnenroll(
  row: Pick<TeamRosterRow, "username" | "github_id">,
): boolean {
  return Boolean(row.username || row.github_id)
}

// Per-role head counts across the roster. `student` counts every row carrying
// the student role (a student who is also staff still counts as a student);
// `teacher`/`hta`/`ta` count every row holding that staff role. A person on two
// teams contributes to each of their roles — these are role tallies, not a
// partition, so they can sum to more than the row count.
export type RoleCounts = Record<ClassroomRole, number>

export function countByRole(rows: TeamRosterRow[]): RoleCounts {
  const counts: RoleCounts = {
    teacher: 0,
    hta: 0,
    ta: 0,
    student: 0,
  }
  for (const row of rows) {
    for (const role of row.roles) counts[role] += 1
  }
  return counts
}

// Enrolled (active-member) head counts by role — the header's "who's in the
// class" numbers. Pending invites are excluded so the counts reflect people
// actually on a team, matching the old enrolled semantics.
export function enrolledCountsByRole(rows: TeamRosterRow[]): RoleCounts {
  return countByRole(rows.filter((r) => r.state === "enrolled"))
}
