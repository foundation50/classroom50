import useGetStudents from "@/hooks/useGetStudents"
import { useTeamRoster } from "@/hooks/useTeamRoster"
import { resolveEmptyRosterWarning } from "@/util/roster"
import type { EmptyRosterDecision } from "@/util/roster"

// Whether to warn a teacher that no student can yet accept an assignment.
//
// The assignment accept link only works for students who are active GitHub org
// members. Enrollment is now team membership (the classroom team is the source
// of truth), so the signal is "zero enrolled team members" — a classroom with
// only pending invites still warrants the warning.
export type EmptyRosterWarning = EmptyRosterDecision

const useEmptyRosterWarning = (
  org: string | undefined,
  classroom: string | undefined,
): EmptyRosterWarning => {
  const { students, isLoading: studentsLoading } = useGetStudents(
    org,
    classroom,
  )
  // Team roster drives enrollment; students.csv is only metadata (passed so the
  // rows can enrich, and so `hasRosterRows` reflects known students).
  const { counts, isLoading, isError } = useTeamRoster(
    org ?? "",
    classroom ?? "",
    students,
  )

  // Decision lives in a pure, unit-tested fn so the branches (esp. the
  // error-as-loading fail-safe) can't drift silently.
  return resolveEmptyRosterWarning({
    studentsLoading,
    isLoading,
    isError,
    enrolledCount: counts.enrolled,
    hasRosterRows: students.length > 0 || counts.pending > 0,
  })
}

export default useEmptyRosterWarning
