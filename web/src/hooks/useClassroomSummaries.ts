import { useQueries } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { csvFileQuery, jsonFileQuery } from "@/hooks/github/queries"
import type { GitHubFileListing } from "@/hooks/github/types"
import {
  isClassroomArchived,
  type Classroom,
  type Student,
} from "@/types/classroom"

export type ClassroomSummary = {
  // The classroom directory slug. Always present, even when classroom.json
  // could not be read, so the row never disappears silently.
  path: string
  name?: string
  short_name?: string
  term?: string
  // Archived lifecycle derived from classroom.json's `active` flag via
  // isClassroomArchived; an unresolved/errored read is treated as active.
  archived: boolean
  // studentCount undefined while pending/unreadable (or when counts aren't
  // requested); callers pin undefined to the bottom in name order.
  studentCount?: number
  // Distinct from a resolved-but-empty classroom.json read.
  loading: boolean
}

// Lifts each classroom's classroom.json (and optionally its roster) to the
// parent so the My Classrooms list can search/sort/filter before rendering.
// Reuses useGetClassroom's jsonFileQuery cache keys and useGetStudents'
// csvFileQuery keys, so no duplicate requests vs. the per-card reads. Roster
// fetches are gated behind `withStudentCounts` (only true when the
// student-count sort is active) to avoid an unnecessary fan-out otherwise.
//
// jsonFileQuery/csvFileQuery use retry:false, so a dir with a missing/malformed
// classroom.json resolves to data===undefined: we keep {path} and mark the rest
// optional rather than dropping a real classroom from the list.
const useClassroomSummaries = (
  org: string | undefined,
  dirs: GitHubFileListing[],
  withStudentCounts: boolean,
): ClassroomSummary[] => {
  const client = useGitHubClient()

  const classroomResults = useQueries({
    queries: dirs.map((dir) =>
      jsonFileQuery<Classroom>(
        client,
        org ?? "",
        "classroom50",
        `${dir.path}/classroom.json`,
      ),
    ),
  })

  const rosterResults = useQueries({
    queries: dirs.map((dir) => ({
      ...csvFileQuery<Student>(
        client,
        org ?? "",
        "classroom50",
        `${dir.path}/students.csv`,
      ),
      enabled: withStudentCounts && Boolean(org && dir.path),
    })),
  })

  return dirs.map((dir, i) => {
    const cl = classroomResults[i]?.data
    const roster = rosterResults[i]?.data
    return {
      path: dir.path,
      name: cl?.name,
      short_name: cl?.short_name,
      term: cl?.term,
      archived: isClassroomArchived(cl ?? {}),
      studentCount: withStudentCounts ? roster?.length : undefined,
      loading: classroomResults[i]?.isPending ?? false,
    }
  })
}

export default useClassroomSummaries

export const classroomDisplayName = (
  summary: ClassroomSummary,
  fallback = "",
) => summary.name || summary.short_name || summary.path || fallback
