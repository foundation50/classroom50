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
}

// Authoritative student count: enrolled members holding the student role, from
// the same team-membership source the Roster page uses. Callers that only need
// the number use this instead of the full useTeamRoster result.
//
// Fan-out: useTeamRoster fires several GitHub reads per classroom (student + 2
// staff team members, owner-gated invitations, org members). Rendered once per
// card on the My Classrooms list, this is a real per-card cost — kept in check
// by owner-gated reads, 404->[] staff reads, and shared query-key caching. The
// roster.csv `role` column is deliberately NOT used; it is stale/absent on
// legacy files, whereas team membership is the source of truth.
const useStudentCount = (
  org: string | undefined,
  classroom: string | undefined,
): StudentCount => {
  const { students } = useGetStudents(org, classroom)
  // students is only the metadata arg useTeamRoster needs to enrich rows; the
  // count derives solely from roleCounts.student, never from the CSV rows.
  const { roleCounts, isLoading, isError } = useTeamRoster(
    org ?? "",
    classroom ?? "",
    students,
  )

  return {
    studentCount: isLoading ? undefined : roleCounts.student,
    isLoading,
    isError,
  }
}

export default useStudentCount
