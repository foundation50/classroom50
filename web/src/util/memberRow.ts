import type { OrgMemberRow } from "@/util/orgMembers"
import type { TeamRosterRow } from "@/util/teamRoster"
import {
  formatName,
  initialsFromParts,
  firstGrapheme,
  type NameOrder,
} from "@/util/students"

// Minimal display shape the shared presentation helpers (initialsFor,
// GitHubIdentity) target. Neither native row satisfies it
// structurally — each view adapts its row via the helpers below — so the shared
// pieces stay decoupled from OrgMemberRow's classroom/classification fields and
// TeamRosterRow's state/first_name/last_name fields.
export type MemberListRow = {
  key: string
  username: string
  github_id: string
  name: string
  email: string
}

// OrgMemberRow already carries a display `name`, so this is a field projection.
export const orgRowToMemberRow = (row: OrgMemberRow): MemberListRow => ({
  key: row.key,
  username: row.username,
  github_id: row.github_id,
  name: row.name,
  email: row.email,
})

// A roster row's display label: name in the user's order, else username, else
// email (a pending email invite has no handle). Shared by the roster table,
// member modal, edit mode, and unlinked-row messages so they can't drift.
export const rosterRowLabel = (
  row: Pick<TeamRosterRow, "first_name" | "last_name" | "username" | "email">,
  order: NameOrder,
): string =>
  formatName(row.first_name, row.last_name, order) || row.username || row.email

// TeamRosterRow has no `name` — derive it via rosterRowLabel so the shared
// header/avatar render a stable label.
export const rosterRowToMemberRow = (
  row: TeamRosterRow,
  order: NameOrder,
): MemberListRow => ({
  key: row.key,
  username: row.username,
  github_id: row.github_id,
  name: rosterRowLabel(row, order),
  email: row.email,
})

// Avatar fallback for a roster row. Two-letter initials from first/last when
// present (initialsFor's single letter isn't equivalent), else the first
// character of the handle/email.
export const rosterRowInitials = (row: TeamRosterRow): string =>
  initialsFromParts(row.first_name, row.last_name) ||
  firstGrapheme(row.username || row.email).toUpperCase() ||
  "?"
