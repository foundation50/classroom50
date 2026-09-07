import { useMemo } from "react"

import useGetStudents from "@/hooks/useGetStudents"
import { useTeamRoster } from "@/hooks/useTeamRoster"
import { unassignedRosterStudents } from "@/domain/teams/groupTeams"
import type { TeamRosterRow } from "@/util/teamRoster"

// A roster student the group add pickers can offer (enrolled, on none of the
// assignment's teams yet), with the display metadata the list rows use: full
// name (may be blank), initials for the avatar fallback, and the combined
// label the pickers show.
export type GroupPickerStudent = {
  key: string
  username: string
  label: string
  name: string
  initials: string
  avatarUrl?: string
}

export type UseGroupRosterResult = {
  // Enrolled roster rows with a GitHub login — the population every
  // group-membership surface derives from.
  enrolled: TeamRosterRow[]
  // Lowercased roster logins, for the add-member roster gate.
  rosterLogins: Set<string>
  // Lowercased login -> roster full name, so group surfaces show real names
  // instead of bare logins.
  fullNameByLogin: Map<string, string>
  isLoading: boolean
}

// The enrolled-roster plumbing shared by every group-management surface
// (groups page, manage/recover dialogs): one derivation of the enrolled rows,
// the roster-login gate set, and the login -> full-name map. React Query
// dedupes the underlying reads across hosts that mount several surfaces.
export function useGroupRoster(
  org: string,
  classroom: string,
): UseGroupRosterResult {
  const { students: csvStudents } = useGetStudents(org, classroom)
  const roster = useTeamRoster(org, classroom, csvStudents)
  const enrolled = useMemo(
    () =>
      roster.rows.filter(
        (row) => row.state === "enrolled" && row.username.trim() !== "",
      ),
    [roster.rows],
  )
  const rosterLogins = useMemo(
    () => new Set(enrolled.map((row) => row.username.trim().toLowerCase())),
    [enrolled],
  )
  const fullNameByLogin = useMemo(() => {
    const map = new Map<string, string>()
    for (const row of enrolled) {
      const name = `${row.first_name} ${row.last_name}`.trim()
      if (name) map.set(row.username.trim().toLowerCase(), name)
    }
    return map
  }, [enrolled])
  return {
    enrolled,
    rosterLogins,
    fullNameByLogin,
    isLoading: roster.isLoading,
  }
}

// Roster students on none of the assignment's teams, shaped for the add
// pickers and the unassigned panel. Pure; callers memo on
// (enrolled, assignedLogins).
export function toGroupPickerStudents(
  enrolled: readonly TeamRosterRow[],
  assignedLogins: ReadonlySet<string>,
): GroupPickerStudent[] {
  return unassignedRosterStudents(enrolled, assignedLogins).map((row) => {
    const name = `${row.first_name} ${row.last_name}`.trim()
    const initials = (
      row.first_name.trim().charAt(0) + row.last_name.trim().charAt(0)
    ).toUpperCase()
    return {
      key: row.key,
      username: row.username,
      name,
      initials,
      avatarUrl: row.avatar_url || undefined,
      label: name ? `${name} (${row.username})` : row.username,
    }
  })
}

export default useGroupRoster
