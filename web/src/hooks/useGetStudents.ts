import { useQuery, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { csvFileQuery, githubKeys } from "./github/queries"
import { toStudent } from "@/util/roster"
import { rosterPath, legacyRosterPath } from "@/util/rosterPath"
import type { Student } from "@/types/classroom"

const rosterKey = (org: string, classroom: string) =>
  githubKeys.csvFile(org, "classroom50", rosterPath(classroom))

// Module-level so the reference is stable: react-query memoizes a `select`
// result only while the selector identity is unchanged. An inline arrow would
// re-map (re-allocating the roster) each render, breaking referential stability
// for downstream useMemo/partition deps. toStudent is a thin, idempotent
// pass-through, so optimistic cache writes pass through unchanged.
const selectStudents = (rows: Student[]): Student[] => rows.map(toStudent)

// Stable empty-roster reference: while the CSV query is loading/undefined, a
// fresh `[]` each render would break referential stability for downstream
// useMemo deps (the team-roster build re-runs needlessly during exactly the
// window the roster queries are resolving).
const EMPTY_STUDENTS: Student[] = []

const useGetStudents = (
  org: string | undefined,
  classroom: string | undefined,
) => {
  const client = useGitHubClient()
  const { data: students, isLoading } = useQuery({
    ...csvFileQuery<Student>(
      client,
      org ?? "",
      "classroom50",
      rosterPath(classroom ?? ""),
      undefined,
      legacyRosterPath(classroom ?? ""),
    ),
    select: selectStudents,
  })

  return {
    students: students ?? EMPTY_STUDENTS,
    isLoading,
  }
}

// Optimistically patch the cached roster. GitHub's Contents API is eventually
// consistent per path: right after a commit it often still serves the previous
// roster.csv, so an immediate refetch would clobber the cache with stale rows.
// Mutations already compute the authoritative post-write rows, so write them in
// and let a natural refetch reconcile. Pass a current->next mapping.
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
    // clobber the optimistic write with stale rows.
    void queryClient.cancelQueries({ queryKey: key })
    queryClient.setQueryData<Student[]>(key, (current) => update(current ?? []))
  }
}

export default useGetStudents
