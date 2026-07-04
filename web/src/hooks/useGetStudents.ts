import { useQuery, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { csvFileQuery, githubKeys } from "./github/queries"
import { toStudent } from "@/util/roster"
import type { Student } from "@/types/classroom"

const rosterKey = (org: string, classroom: string) =>
  githubKeys.csvFile(org, "classroom50", `${classroom}/students.csv`)

// Module-level so the reference is stable: react-query memoizes a `select`
// result only while the selector identity is unchanged, so an inline arrow
// would re-map (and re-allocate the roster array) on every render, breaking
// referential stability for downstream useMemo/partition deps.
const selectStudents = (rows: Student[]): Student[] => rows.map(toStudent)

const useGetStudents = (
  org: string | undefined,
  classroom: string | undefined,
) => {
  const client = useGitHubClient()
  // toStudent is a thin pass-through over the 6-column Student (via
  // normalizeStudentRow), kept module-level so `selectStudents`'s identity is
  // stable for react-query's memoized `select`. It is idempotent over an
  // already-typed Student, so optimistic cache writes pass through unchanged.
  const { data: students, isLoading } = useQuery({
    ...csvFileQuery<Student>(
      client,
      org ?? "",
      "classroom50",
      `${classroom ?? ""}/students.csv`,
    ),
    select: selectStudents,
  })

  return {
    students: students || [],
    isLoading,
  }
}

// Optimistically patch the cached roster. GitHub's Contents API is eventually
// consistent per path: right after a commit it often still serves the previous
// students.csv, so an immediate refetch would clobber the cache with stale rows
// until a later refresh. Mutations already compute the authoritative post-write
// rows, so write them straight in and let a natural refetch reconcile. Pass a
// function mapping the current roster to the next.
export const useUpdateRosterCache = (
  org: string | undefined,
  classroom: string | undefined,
) => {
  const queryClient = useQueryClient()
  return (update: (current: Student[]) => Student[]) => {
    if (!org || !classroom) return
    const key = rosterKey(org, classroom)
    // Cancel any in-flight roster fetch first: a refetch started before the
    // commit (window-focus/reconnect) could resolve after this setQueryData and
    // clobber the optimistic write with stale rows. cancelQueries drops it.
    void queryClient.cancelQueries({ queryKey: key })
    queryClient.setQueryData<Student[]>(key, (current) => update(current ?? []))
  }
}

export default useGetStudents
