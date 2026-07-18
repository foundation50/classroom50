import { useMemo } from "react"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import {
  useStudentClassrooms,
  type StudentClassroom,
} from "@/hooks/useStudentClassrooms"

// A student's classroom enriched with how many of its assignments they've
// accepted (derived from their own repos, config-free).
export type StudentClassroomSummary = StudentClassroom & {
  acceptedCount: number
}

export type UseStudentClassroomSummariesResult = {
  summaries: StudentClassroomSummary[]
  isLoading: boolean
  isError: boolean
  roleResolved: boolean
  refetch: () => void
}

// Combine the teams-derived classroom list (useStudentClassrooms) with the
// student's accepted-repo counts (useGetMyOrgRepos), grouping repos by the
// `<classroom>-<assignment>-<owner>` name prefix. The capability secret already
// rides along on each classroom's bootstrap record (team description); the
// per-classroom view (StudentAssignmentList) resolves the repo-`.classroom50.yaml`
// fallback for a pre-schema team, since that read is scoped to one classroom.
export function useStudentClassroomSummaries(
  org: string | undefined,
): UseStudentClassroomSummariesResult {
  const {
    classrooms,
    isLoading: classroomsLoading,
    isError: classroomsError,
    roleResolved,
    refetch,
  } = useStudentClassrooms(org)
  const { data: repos } = useGetOrgRepos(org ?? "")

  const summaries = useMemo<StudentClassroomSummary[]>(() => {
    const writable = (repos ?? []).filter((repo) => repo.permissions?.push)
    return classrooms.map((c) => {
      // Classroom repos are `<classroom>-<assignment>-<owner>`; require the
      // trailing "-" so a sibling classroom whose name extends this one (e.g.
      // "cs" vs "cs101-...") isn't miscounted.
      const prefix = `${c.classroom}-`
      const acceptedCount = writable.filter((repo) =>
        repo.name.toLowerCase().startsWith(prefix.toLowerCase()),
      ).length
      return { ...c, acceptedCount }
    })
  }, [classrooms, repos])

  return {
    summaries,
    isLoading: classroomsLoading,
    isError: classroomsError,
    roleResolved,
    refetch,
  }
}

export default useStudentClassroomSummaries
