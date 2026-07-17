import { NO_SECTION } from "@/pages/students/rosterFilter"

// Group rows by `section`, sorted by name with the unlabeled ("No section")
// bucket last. Generic over any row with a `section` field.
export function groupStudentsBySection<T extends { section?: string }>(
  students: T[],
): Array<{ section: string; students: T[] }> {
  const bySection = new Map<string, T[]>()
  for (const student of students) {
    const label = student.section?.trim() || NO_SECTION
    const bucket = bySection.get(label)
    if (bucket) bucket.push(student)
    else bySection.set(label, [student])
  }
  return Array.from(bySection.entries())
    .sort(([a], [b]) => {
      if (a === NO_SECTION) return 1
      if (b === NO_SECTION) return -1
      return a.localeCompare(b, undefined, { numeric: true })
    })
    .map(([section, group]) => ({ section, students: group }))
}

// After a metadata save, where should the open detail modal's selection point?
// An edit can't change an editable row's identity (rows key on
// github_id/username; the form edits only name/email/section), so this is
// normally a no-op — but if the key ever moves, follow it so the modal stays on
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
