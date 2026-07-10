import { nameFromParts } from "@/util/students"
import type {
  RosterRole,
  TeamRosterRow,
  TeamRosterRowState,
} from "@/util/teamRoster"

// The unlabeled section bucket. Shared by the filter and the group-by-section
// view so a row with no section is treated identically in both.
export const NO_SECTION = "No section"

export type StatusFilter = "all" | TeamRosterRowState
export type RoleFilter = "all" | RosterRole

export type RosterFilterInput = {
  query: string
  statusFilter: StatusFilter
  roleFilter: RoleFilter
  // Already resolved to "all" or an existing section label by the caller.
  sectionFilter: string
}

// Pure roster-row filter: text search over username/name/email, ANDed with the
// status, role, and section facets. Extracted from the view so the (previously
// untested) role-filter branch can be unit-tested. A role match is
// `roles.includes(role)`, so a multi-role person shows under each of their
// roles.
export function filterRosterRows(
  rows: TeamRosterRow[],
  { query, statusFilter, roleFilter, sectionFilter }: RosterFilterInput,
): TeamRosterRow[] {
  const q = query.trim().toLowerCase()
  return rows.filter((row) => {
    if (statusFilter !== "all" && row.state !== statusFilter) return false
    if (roleFilter !== "all" && !row.roles.includes(roleFilter)) return false
    if (sectionFilter !== "all") {
      const section = row.section.trim() || NO_SECTION
      if (section !== sectionFilter) return false
    }
    if (!q) return true
    const name = nameFromParts(row.first_name, row.last_name)
    return [row.username, name, row.email].some((field) =>
      field.toLowerCase().includes(q),
    )
  })
}
