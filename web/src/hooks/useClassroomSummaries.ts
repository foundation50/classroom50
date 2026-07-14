import { useQueries } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { jsonFileQuery } from "@/hooks/github/queries"
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
  // Distinct from a resolved-but-empty classroom.json read.
  loading: boolean
}

// Lifts each classroom's classroom.json to the parent so the My Classrooms list
// can search/sort/filter before rendering the cards. Reuses useGetClassroom's
// jsonFileQuery cache keys, so no duplicate requests vs. the per-card reads.
//
// The student-count sort's per-classroom counts are NOT fetched here: that sort
// needs an authoritative role-aware count (useStudentCount), and calling a hook
// per dir in this hook would violate the Rules of Hooks when the classroom list
// grows/shrinks without a remount. ClassroomList collects those counts via
// keyed probe components instead and merges them in (see StudentCountProbes and
// useStudentCount).
//
// jsonFileQuery uses retry:false, so a dir with a missing/malformed
// classroom.json resolves to data===undefined: we keep {path} and mark the rest
// optional rather than dropping a real classroom from the list.
const useClassroomSummaries = (
  org: string | undefined,
  dirs: GitHubFileListing[],
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

  return dirs.map((dir, i) => {
    const cl = classroomResults[i]?.data
    return {
      path: dir.path,
      name: cl?.name,
      short_name: cl?.short_name,
      term: cl?.term,
      archived: isClassroomArchived(cl ?? {}),
      loading: classroomResults[i]?.isPending ?? false,
    }
  })
}

export default useClassroomSummaries

export const classroomDisplayName = (
  summary: ClassroomSummary,
  fallback = "",
) => summary.name || summary.short_name || summary.path || fallback
