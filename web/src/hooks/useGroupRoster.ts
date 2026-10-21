import { useMemo } from "react"

import useGetStudents from "@/hooks/useGetStudents"
import { useTeamRoster } from "@/hooks/useTeamRoster"
import { useUserPreference } from "@/context/userPreferences/UserPreferencesProvider"
import { unassignedRosterStudents } from "@/domain/teams/groupTeams"
import { hasStudentEnrollment, staffRolesByLogin } from "@/util/classroomRoleUI"
import {
  DEFAULT_NAME_ORDER,
  formatName,
  initialsFromParts,
  type NameOrder,
} from "@/util/students"
import type { ClassroomRole, TeamRosterRow } from "@/util/teamRoster"

// A roster member the group add pickers can offer (enrolled, on none of the
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
  // False only when the viewer can tell this person holds no student
  // enrollment; see partitionGroupPickerStudents.
  isStudent: boolean
}

export type UseGroupRosterResult = {
  // Enrolled roster rows with a GitHub login (students AND staff) — the
  // population every group-membership surface derives from.
  enrolled: TeamRosterRow[]
  // Lowercased roster logins, for the add-member roster gate. Includes staff,
  // so a teacher can put a TA in a group to test the assignment.
  rosterLogins: Set<string>
  // Lowercased login -> roster full name, so group surfaces show real names
  // instead of bare logins.
  fullNameByLogin: Map<string, string>
  // Lowercased login -> staff roles, for the badge on a staff member's row.
  // A plain student is absent.
  staffRolesByLogin: Map<string, ClassroomRole[]>
  // Whether a row's roles can tell staff-only members from students. False
  // when the student team was unreadable and roster.csv stood in for it: the
  // CSV records one role per person (the highest), so a TA who is also a
  // student reads as staff-only there (#1123).
  staffSplitKnown: boolean
  isLoading: boolean
}

// The enrolled-roster plumbing shared by every group-management surface
// (groups page, manage/recover dialogs); UseGroupRosterResult documents each
// output. React Query dedupes the underlying reads across hosts that mount
// several surfaces.
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
  const nameOrder = useUserPreference("nameOrder")
  const fullNameByLogin = useMemo(() => {
    const map = new Map<string, string>()
    for (const row of enrolled) {
      const name = formatName(row.first_name, row.last_name, nameOrder)
      if (name) map.set(row.username.trim().toLowerCase(), name)
    }
    return map
  }, [enrolled, nameOrder])
  const staffRoles = useMemo(() => staffRolesByLogin(enrolled), [enrolled])
  const staffSplitKnown = !roster.studentTeamHidden
  const isLoading = roster.isLoading
  // Stable identity, so callers can memo on the result as one dependency.
  return useMemo(
    () => ({
      enrolled,
      rosterLogins,
      fullNameByLogin,
      staffRolesByLogin: staffRoles,
      staffSplitKnown,
      isLoading,
    }),
    [
      enrolled,
      rosterLogins,
      fullNameByLogin,
      staffRoles,
      staffSplitKnown,
      isLoading,
    ],
  )
}

// Roster members on none of the assignment's teams, shaped for the add
// pickers and the unassigned panel. Pure; callers memo on the inputs.
export function toGroupPickerStudents(
  roster: Pick<UseGroupRosterResult, "enrolled" | "staffSplitKnown">,
  assignedLogins: ReadonlySet<string>,
  nameOrder: NameOrder = DEFAULT_NAME_ORDER,
): GroupPickerStudent[] {
  return unassignedRosterStudents(roster.enrolled, assignedLogins).map(
    (row) => {
      const name = formatName(row.first_name, row.last_name, nameOrder)
      const initials = initialsFromParts(row.first_name, row.last_name)
      return {
        key: row.key,
        username: row.username,
        name,
        initials,
        avatarUrl: row.avatar_url || undefined,
        label: name ? `${name} (${row.username})` : row.username,
        isStudent: !roster.staffSplitKnown || hasStudentEnrollment(row),
      }
    },
  )
}

// Split a picker pool into students and staff-only members. The unassigned
// panel lists only `students` (a TA who never joins a group isn't a problem to
// fix), while the pickers offer both so staff can still be placed in a group.
export function partitionGroupPickerStudents(
  pool: readonly GroupPickerStudent[],
): { students: GroupPickerStudent[]; staff: GroupPickerStudent[] } {
  const students: GroupPickerStudent[] = []
  const staff: GroupPickerStudent[] = []
  for (const entry of pool) (entry.isStudent ? students : staff).push(entry)
  return { students, staff }
}

export default useGroupRoster
