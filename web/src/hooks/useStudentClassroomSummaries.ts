import { useMemo } from "react"
import { useGithubAuth } from "@/auth/useGithubAuth"
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
// student's accepted-repo counts (useGetMyOrgRepos). An accepted repo is the
// student's OWN `<classroom>-<assignment>-<login>` repo, so we match both the
// `<classroom>-` prefix AND the `-<login>` suffix — the same identity
// StudentAssignmentList checks via studentRepoName. This keeps the card's count
// consistent with the assignment list and excludes unrelated writable repos
// (e.g. a personal `<classroom>-notes`) and other owners' group repos.
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
  const { user } = useGithubAuth()
  const { data: repos } = useGetOrgRepos(org ?? "")

  const summaries = useMemo<StudentClassroomSummary[]>(() => {
    const login = user?.login?.toLowerCase()
    const writableNames = (repos ?? [])
      .filter((repo) => repo.permissions?.push)
      .map((repo) => repo.name.toLowerCase())
    return classrooms.map((c) => {
      // Match the student's own repo identity: `<classroom>-<assignment>-<login>`
      // (require the trailing "-" on the prefix so a sibling classroom whose name
      // extends this one — "cs" vs "cs101-..." — isn't miscounted). Without a
      // resolved login, fall back to the prefix-only count rather than reporting 0.
      const prefix = `${c.classroom.toLowerCase()}-`
      const suffix = login ? `-${login}` : ""
      const acceptedCount = writableNames.filter(
        (name) => name.startsWith(prefix) && name.endsWith(suffix),
      ).length
      return { ...c, acceptedCount }
    })
  }, [classrooms, repos, user?.login])

  return {
    summaries,
    isLoading: classroomsLoading,
    isError: classroomsError,
    roleResolved,
    refetch,
  }
}

export default useStudentClassroomSummaries
