import { useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  csvFileQuery,
  githubKeys,
  rosterRawFileQuery,
} from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"
import { toStudent } from "@/util/roster"
import { rosterPath, legacyRosterPath } from "@/util/rosterPath"
import { parseRosterCsv, type RosterCsvProblem } from "@/domain/students"
import type { Student } from "@/types/classroom"

const rosterKey = (org: string, classroom: string) =>
  githubKeys.csvFile(org, CONFIG_REPO, rosterPath(classroom))

// Module-level so the reference is stable: react-query memoizes a `select`
// result only while the selector identity is unchanged. An inline arrow would
// re-map (re-allocating the roster) each render, breaking referential stability
// for downstream useMemo/partition deps. toStudent is a thin, idempotent
// pass-through, so optimistic cache writes pass through unchanged.
const selectStudents = (rows: Student[]): Student[] => rows.map(toStudent)

// Stable empty references so a loading/undefined read doesn't break referential
// stability for downstream useMemo deps during the resolve window.
const EMPTY_STUDENTS: Student[] = []
const EMPTY_PROBLEMS: RosterCsvProblem[] = []

const useGetStudents = (
  org: string | undefined,
  classroom: string | undefined,
) => {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { data: students, isLoading } = useQuery({
    ...csvFileQuery<Student>(
      client,
      org ?? "",
      CONFIG_REPO,
      rosterPath(classroom ?? ""),
      undefined,
      legacyRosterPath(classroom ?? ""),
    ),
    select: selectStudents,
  })

  // A parallel strict read of the raw bytes purely to detect malformed rows and
  // report them per line. Kept separate from the display read above (which
  // stays tolerant so a partial file still renders what it can) so a bad file
  // surfaces a precise banner instead of silently misaligned rows.
  const {
    data: rawRoster,
    refetch: refetchRawRoster,
    isFetching: rawRosterFetching,
  } = useQuery(
    rosterRawFileQuery(
      client,
      org ?? "",
      CONFIG_REPO,
      rosterPath(classroom ?? ""),
      legacyRosterPath(classroom ?? ""),
    ),
  )
  const parseProblems = useMemo(
    () => (rawRoster ? parseRosterCsv(rawRoster).problems : EMPTY_PROBLEMS),
    [rawRoster],
  )

  return {
    students: students ?? EMPTY_STUDENTS,
    isLoading,
    parseProblems,
    // Re-read the raw roster.csv so a teacher who just fixed the file can
    // re-verify it in place (also refetches the tolerant display read).
    recheckRoster: () => {
      void refetchRawRoster()
      void queryClient.invalidateQueries({
        queryKey: rosterKey(org ?? "", classroom ?? ""),
      })
    },
    rechecking: rawRosterFetching,
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
