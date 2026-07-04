import type { Student } from "@/types/classroom"
import { normalizeStudentRow, splitName } from "@/api/mutations/students"
import { studentKey } from "@/util/identity"

// Re-exported so UI callers keep importing splitName/studentKey from the roster
// util while the single canonical implementations live elsewhere (splitName
// alongside the CSV write path; studentKey in @/util/identity).
export { splitName, studentKey }

// Narrow a raw CSV row into a typed Student. Defaulting + trimming of every
// column is delegated to the canonical normalizeStudentRow (one shared column
// list with the write path). The CSV is now just the 6 identity/metadata
// columns, so this is a thin pass-through.
export function toStudent(row: Record<string, string>): Student {
  return normalizeStudentRow(row)
}

// Remove rows matching `key` for the optimistic unenroll update. Removes ALL
// rows that collapse to the same key (mirroring the server's match predicate);
// a later refetch restores any survivor.
export function removeFromRoster(current: Student[], key: string): Student[] {
  return current.filter((student) => studentKey(student) !== key)
}

// Pure decision shape for the empty-roster warning (computed team-driven in
// useEmptyRosterWarning). Kept as a type so the hook's return stays named.
export type EmptyRosterDecision = {
  show: boolean
  hasRosterRows: boolean
  isLoading: boolean
}

// Pure decision for the empty-roster warning, kept React-free (no hooks) so the
// branches are unit-testable in isolation. Enrollment is team membership, so
// `enrolledCount` is the team-member enrolled count.
//
// A team-roster READ ERROR folds into loading on purpose: never assert an empty
// classroom on a transient/permission failure — the view shows an error+retry
// instead, and the banner self-heals on recovery. The alternative (treating an
// error as "settled") would false-warn a populated classroom during a blip.
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
