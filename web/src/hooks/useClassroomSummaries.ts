import { useQueries } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { jsonFileQuery } from "@/hooks/github/queries"
import useStudentCount from "@/hooks/useStudentCount"
import type { GitHubFileListing } from "@/hooks/github/types"
import { isClassroomArchived, type Classroom } from "@/types/classroom"

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

// Lifts each classroom's classroom.json to the parent so the My Classrooms list
// can search/sort/filter before rendering the cards. Reuses useGetClassroom's
// jsonFileQuery cache keys, so no duplicate requests vs. the per-card reads.
// When the student-count sort is active, it also fetches the authoritative
// role-aware student count per classroom (same useStudentCount the cards use),
// gated behind `withStudentCounts` so the team-membership fan-out only happens
// then.
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

  // Authoritative role-aware student count per classroom, from the single
  // useStudentCount source (R5) — never roster.csv row count, which includes
  // staff. dirs is a stable-length listing for a mounted list (it changes only
  // on create/delete, which remounts), so a hook-per-dir is safe here.
  const studentCounts = dirs.map((dir) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useStudentCount(
      withStudentCounts ? org : undefined,
      withStudentCounts ? dir.path : undefined,
    ),
  )

  return dirs.map((dir, i) => {
    const cl = classroomResults[i]?.data
    return {
      path: dir.path,
      name: cl?.name,
      short_name: cl?.short_name,
      term: cl?.term,
      archived: isClassroomArchived(cl ?? {}),
      studentCount: withStudentCounts ? studentCounts[i]?.studentCount : undefined,
      loading: classroomResults[i]?.isPending ?? false,
    }
  })
}

export default useClassroomSummaries

export const classroomDisplayName = (
  summary: ClassroomSummary,
  fallback = "",
) => summary.name || summary.short_name || summary.path || fallback
