import type { Student } from "@/types/classroom"
import { normalizeStudentRow, splitName } from "@/util/rosterCsv"
import { studentKey } from "@/util/identity"

// Re-exported so UI callers keep importing splitName/studentKey from here while
// the canonical implementations live elsewhere (splitName by the CSV write
// path; studentKey in @/util/identity).
export { splitName, studentKey }

// Narrow a raw CSV row into a typed Student. Defaulting/trimming is delegated
// to the canonical normalizeStudentRow (one shared column list with the write
// path), so this is a thin pass-through.
export function toStudent(row: Record<string, string>): Student {
  return normalizeStudentRow(row)
}

// Remove rows matching `key` for the optimistic unenroll update. Removes ALL
// rows that collapse to `key` (mirroring the server); a refetch restores any
// survivor.
export function removeFromRoster(current: Student[], key: string): Student[] {
  return current.filter((student) => studentKey(student) !== key)
}

// Pure decision shape for the empty-roster warning. Kept as a type so the
// hook's return stays named.
export type EmptyRosterDecision = {
  show: boolean
  hasRosterRows: boolean
  isLoading: boolean
}

// Pure decision for the empty-roster warning, React-free so branches are
// testable. Enrollment is team membership, so `enrolledCount` is the team-member
// count.
//
// A team-roster READ ERROR folds into loading on purpose: never assert an empty
// classroom on a transient/permission failure — the view shows error+retry and
// the banner self-heals. Treating an error as "settled" would false-warn a
// populated classroom during a blip.
export function resolveEmptyRosterWarning(input: {
  studentsLoading: boolean
  isLoading: boolean
  isError: boolean
  enrolledCount: number
  hasRosterRows: boolean
}): EmptyRosterDecision {
  const loading = input.studentsLoading || input.isLoading || input.isError
  return {
    show: !loading && input.enrolledCount === 0,
    hasRosterRows: input.hasRosterRows,
    isLoading: loading,
  }
}
