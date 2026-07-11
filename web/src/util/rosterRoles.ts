import type { BadgeTone } from "@/components/ui"
import {
  ROLE_RANK,
  sortRolesByRank,
  type RosterRole,
  type TeamRosterRow,
  type TeamRosterRowState,
} from "@/util/teamRoster"

// Single source of truth for how a classroom role is presented and ranked.
// Shared by the Roster view and the classroom Settings staff section so the two
// surfaces can't drift on tone or precedence (AGENTS.md: one recipe, one source).
// ROLE_RANK and sortRolesByRank live in teamRoster (next to the row type they
// order) and are re-exported here so UI callers have one import for all role
// presentation.
export { ROLE_RANK, sortRolesByRank }

// i18n key per role for row badges and filter labels.
export const ROLE_LABEL_KEY: Record<RosterRole, string> = {
  instructor: "students.roleInstructor",
  ta: "students.roleTa",
  student: "students.roleStudent",
}

// Badge tone per role, distinct from the warning/error status tones so role and
// enrollment state read as separate facets. `student` uses the neutral ghost
// chip (rendered with the Badge `ghost` prop), so it maps to "neutral" here.
export const ROLE_BADGE_TONE: Record<RosterRole, BadgeTone> = {
  instructor: "primary",
  ta: "secondary",
  student: "neutral",
}

// Enrollment-state badge tone + i18n label, single-sourced so the roster row
// list and the member modal render the same status chip (AGENTS.md: one recipe,
// one source — previously hand-synced across EnrolledStudents + RosterMemberModal
// and already drifted once on a renamed key).
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

// A row's single highest-precedence role for the primary badge (instructor >
// ta > student). Roles are stored ROLE_RANK-sorted (see addRole in teamRoster),
// so the first is the highest; this is a named accessor so callers don't reach
// into roles[0] and re-encode the sort assumption.
export function primaryRole(row: Pick<TeamRosterRow, "roles">): RosterRole {
  return sortRolesByRank(row.roles)[0]
}

// Whether a row carries a student enrollment (a roster.csv row + student-team
// membership). True for a plain student AND for a student who is also staff.
// The single definition of "can be unenrolled": unenroll drops only the student
// enrollment (CSV row + student-team membership), leaving any staff role intact,
// so it applies to anyone with a student role — shared by the row modal's
// unenroll gate and the bulk-select gate so the two can't diverge (a
// student+instructor must be offered unenroll in BOTH surfaces, never one).
export function hasStudentEnrollment(
  row: Pick<TeamRosterRow, "roles">,
): boolean {
  return row.roles.includes("student")
}

// Per-role head counts across the roster. `student` counts every row carrying
// the student role (a student who is also staff still counts as a student);
// `instructor`/`ta` count every row holding that staff role. A person on two
// teams contributes to each of their roles — these are role tallies, not a
// partition, so they can sum to more than the row count.
export type RoleCounts = Record<RosterRole, number>

export function countByRole(rows: TeamRosterRow[]): RoleCounts {
  const counts: RoleCounts = { instructor: 0, ta: 0, student: 0 }
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
