import type {
  EnrollmentMethod,
  EnrollmentStatus,
  Student,
} from "@/types/classroom"
import { normalizeStudentRow, splitName } from "@/api/mutations/students"
import { studentKey } from "@/util/identity"

// Re-exported so UI callers keep importing splitName/studentKey from the roster
// util while the single canonical implementations live elsewhere (splitName
// alongside the CSV write path; studentKey in @/util/identity).
export { splitName, studentKey }

const ENROLLMENT_STATUSES: readonly EnrollmentStatus[] = [
  "invited",
  "enrolled",
  "",
]
const ENROLLMENT_METHODS: readonly EnrollmentMethod[] = ["github", "email", ""]

// Narrow a raw CSV row into a typed Student. Defaulting + trimming of every
// column is delegated to the canonical normalizeStudentRow (one column list,
// shared with the write path); toStudent only narrows enrollment_status/method
// to their string-literal unions, coercing an unknown/off-list value to "".
export function toStudent(row: Record<string, string>): Student {
  const normalized = normalizeStudentRow(row)
  const status = ENROLLMENT_STATUSES.includes(
    normalized.enrollment_status as EnrollmentStatus,
  )
    ? (normalized.enrollment_status as EnrollmentStatus)
    : ""
  const method = ENROLLMENT_METHODS.includes(
    normalized.enrollment_method as EnrollmentMethod,
  )
    ? (normalized.enrollment_method as EnrollmentMethod)
    : ""
  return { ...normalized, enrollment_status: status, enrollment_method: method }
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
