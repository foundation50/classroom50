import { useMemo } from "react"
import { useQuery, useQueries } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  csvFileQuery,
  githubKeys,
  jsonFileQuery,
  listAllOrgMembers,
  orgAdminsQuery,
} from "@/hooks/github/queries"
import useGetClasses from "@/hooks/useGetClasses"
import { toStudent } from "@/util/roster"
import {
  isClassroomArchived,
  type Classroom,
  type Student,
} from "@/types/classroom"
import { aggregateOrgMembers, type OrgMemberRow } from "@/util/orgMembers"
import type { GitHubUser } from "@/hooks/github/types"

export type OrgMembersOverview = {
  rows: OrgMemberRow[]
  // The org's live members (all pages), the trust anchor for bulk-add
  // membership verification.
  members: GitHubUser[]
  // Numeric ids of org owners/admins, so the view can badge them "Owner"
  // instead of "Member". Empty when the admin list couldn't be read.
  ownerIds: Set<string>
  isLoading: boolean
  isError: boolean
  // Per-classroom roster read failures (a 404 / parse error contributes no
  // students rather than failing the whole page).
  notes: string[]
}

// Aggregate the org's members against every classroom roster: dedupe students,
// match to live members, classify discrepancies, surface per-student classroom
// access.
const useOrgMembersOverview = (org: string | undefined): OrgMembersOverview => {
  const client = useGitHubClient()

  const membersQuery = useQuery({
    queryKey: githubKeys.orgMembersAll(org ?? ""),
    queryFn: () => listAllOrgMembers(client, org ?? ""),
    enabled: Boolean(org),
    staleTime: 5 * 60 * 1000,
  })

  const adminsQuery = useQuery({
    ...orgAdminsQuery(client, org ?? ""),
    enabled: Boolean(org),
  })

  const { classes } = useGetClasses(org)
  // Key by `path` (not `name`) to match useGetClassroom/useGetStudents so these
  // reads hit the same react-query cache instead of duplicating requests.
  const classroomNames = useMemo(() => classes.map((c) => c.path), [classes])

  const metaQueries = useQueries({
    queries: classroomNames.map((name) => ({
      ...jsonFileQuery<Classroom>(
        client,
        org ?? "",
        "classroom50",
        `${name}/classroom.json`,
      ),
      enabled: Boolean(org),
    })),
  })

  const rosterQueries = useQueries({
    queries: classroomNames.map((name) => ({
      ...csvFileQuery<Student>(
        client,
        org ?? "",
        "classroom50",
        `${name}/students.csv`,
      ),
      enabled: Boolean(org),
      select: (rows: Student[]) => rows.map(toStudent),
    })),
  })

  const members = useMemo(() => membersQuery.data ?? [], [membersQuery.data])

  const metaSignature = metaQueries.map((q) => (q.data ? "d" : "")).join("|")
  const rosterSignature = rosterQueries
    .map((q) => (q.isError ? "e" : q.data ? "d" : ""))
    .join("|")

  const { rosters, notes } = useMemo(() => {
    const collected = classroomNames.map((name, i) => {
      const meta = metaQueries[i]?.data
      const rosterQuery = rosterQueries[i]
      return {
        classroom: name,
        archived: meta ? isClassroomArchived(meta) : false,
        students: (rosterQuery?.data as Student[] | undefined) ?? [],
        failed: rosterQuery?.isError ?? false,
      }
    })
    const failedNotes = collected
      .filter((c) => c.failed)
      .map(
        (c) =>
          `Couldn't read the roster for "${c.classroom}" — its students are not shown.`,
      )
    return {
      rosters: collected.map(({ classroom, archived, students }) => ({
        classroom,
        archived,
        students,
      })),
      notes: failedNotes,
    }
    // metaQueries/rosterQueries are fresh arrays each render; depend on the
    // names plus stable signatures of the data/error we actually read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classroomNames, metaSignature, rosterSignature])

  const rows = useMemo(
    () => aggregateOrgMembers(members, rosters),
    [members, rosters],
  )

  const ownerIds = useMemo(
    () => new Set((adminsQuery.data ?? []).map((m) => String(m.id))),
    [adminsQuery.data],
  )

  const isLoading =
    membersQuery.isLoading ||
    metaQueries.some((q) => q.isLoading) ||
    rosterQueries.some((q) => q.isLoading)
  const isError = membersQuery.isError

  return { rows, members, ownerIds, isLoading, isError, notes }
}

export default useOrgMembersOverview
