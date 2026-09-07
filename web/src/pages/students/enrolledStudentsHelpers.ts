import { NO_SECTION } from "@/pages/students/rosterFilter"
import { ROLE_RANK, type ClassroomRole } from "@/util/teamRoster"

// The parts of a roster sync worth reporting, in the order they're announced.
// One commit can append team members and complete accepted email invitations,
// so a single count would under-report (and read as "Added 0 members" for an
// invite-only pass).
export function rosterSyncMessageKeys(result: {
  addedUsernames: string[]
  recoveredEmails: string[]
  noop: boolean
}): Array<{ key: string; count: number }> {
  if (result.noop) return []
  return (
    [
      { key: "students.syncAdded", count: result.addedUsernames.length },
      {
        key: "students.syncMatchedEmails",
        count: result.recoveredEmails.length,
      },
    ] as const
  ).filter((part) => part.count > 0)
}

// Group rows by `section`, sorted by name with the unlabeled ("No section")
// bucket last. Generic over any row with a `section` field.
export function groupStudentsBySection<T extends { section?: string }>(
  students: T[],
): Array<{ section: string; students: T[] }> {
  const bySection = Map.groupBy(
    students,
    (student) => student.section?.trim() || NO_SECTION,
  )
  return Array.from(bySection.entries())
    .sort(([a], [b]) => {
      if (a === NO_SECTION) return 1
      if (b === NO_SECTION) return -1
      return a.localeCompare(b, undefined, { numeric: true })
    })
    .map(([section, group]) => ({ section, students: group }))
}

// Group rows by their PRIMARY (highest-ranked) role, ordered teacher-first —
// the precedence RoleBadges leads with, so a group's header matches the first
// chip on every row in it. Rows keep their incoming (sorted) order.
export function groupStudentsByRole<T extends { roles: ClassroomRole[] }>(
  students: T[],
): Array<{ role: ClassroomRole; students: T[] }> {
  const primary = (roles: ClassroomRole[]): ClassroomRole =>
    roles.reduce<ClassroomRole>(
      (top, role) => (ROLE_RANK[role] > ROLE_RANK[top] ? role : top),
      "student",
    )
  const byRole = Map.groupBy(students, (student) => primary(student.roles))
  return Array.from(byRole.entries())
    .sort(([a], [b]) => ROLE_RANK[b] - ROLE_RANK[a])
    .map(([role, group]) => ({ role, students: group }))
}

// After a metadata save, where should the open detail modal's selection point?
// Rows key on github_id || username || email, and the one field that can be a
// key — the address of a pending invite — is locked in the form, so this is
// normally a no-op. If the key ever moves, follow it so the modal stays on
// the same person instead of snapping shut. Only re-points the row that was
// saved; any other selection is left alone.
export function nextSelectedKeyAfterSave(
  prev: string | null,
  savedRowKey: string,
  nextRowKey: string,
): string | null {
  if (!nextRowKey || nextRowKey === savedRowKey) return prev
  return prev === savedRowKey ? nextRowKey : prev
}
