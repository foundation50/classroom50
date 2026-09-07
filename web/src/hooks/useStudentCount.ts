import useGetStudents from "@/hooks/useGetStudents"
import { useTeamRoster } from "@/hooks/useTeamRoster"

export type StudentCount = {
  // Enrolled student-role head count, or undefined while the authoritative
  // source resolves. Distinct from a resolved 0 (a staff-only classroom).
  studentCount: number | undefined
  isLoading: boolean
  // A role-count read failed; callers degrade gracefully instead of showing a
  // wrong number (a bare `?? 0` would render a misleading "0 students").
  isError: boolean
  // The count is unknowable to this viewer: a non-owner whose student team is
  // hidden (every classroom team is `secret`) and whose roster.csv lists no
  // students. Settled, not loading — callers show nothing rather than a spinner
  // or "0 students".
  isUnknown: boolean
}

// Authoritative student count: enrolled members holding the student role, from
// the same team-membership source the Roster page uses. Callers that only need
// the number use this instead of the full useTeamRoster result.
//
// Fan-out: useTeamRoster fires several GitHub reads per classroom (student + 2
// staff team members, owner-gated invitations, org members). Rendered once per
// card on the My Classrooms list, this is a real per-card cost — kept in check
// by owner-gated reads, 404->[] staff reads, and shared query-key caching. The
// roster.csv `role` column is not consulted directly here; useTeamRoster reads
// it only as a stand-in for a team the viewer cannot see.
const useStudentCount = (
  org: string | undefined,
  classroom: string | undefined,
): StudentCount => {
  const { students } = useGetStudents(org, classroom)
  // students is only the metadata arg useTeamRoster needs to enrich rows; the
  // count derives solely from roleCounts.student, never from the CSV rows.
  const { roleCounts, isLoading, isError, studentRosterKnown } = useTeamRoster(
    org ?? "",
    classroom ?? "",
    students,
  )
  const isUnknown = !isLoading && !isError && !studentRosterKnown

  return {
    studentCount: isLoading || isUnknown ? undefined : roleCounts.student,
    isLoading,
    isError,
    isUnknown,
  }
}

export default useStudentCount
