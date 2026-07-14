import { useMemo } from "react"
import { useQuery, useQueries } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  csvFileQuery,
  jsonFileQuery,
  orgAdminsQuery,
  orgMembersAllQuery,
  teamMembersQuery,
} from "@/hooks/github/queries"
import { CONFIG_REPO } from "@/util/configRepo"
import useGetClasses from "@/hooks/useGetClasses"
import { classroomTeamSlugHeuristic } from "@/util/orgMembership"
import { toStudent } from "@/util/roster"
import { rosterPath, legacyRosterPath } from "@/util/rosterPath"
import {
  isClassroomArchived,
  type Classroom,
  type Student,
} from "@/types/classroom"
import { aggregateOrgMembers, type OrgMemberRow } from "@/util/orgMembers"
import { memberIdSet } from "@/util/identity"
import type { GitHubUser } from "@/hooks/github/types"

export type OrgMembersOverview = {
  rows: OrgMemberRow[]
  // The org's live members (all pages), the trust anchor for bulk-add
  // membership verification.
  members: GitHubUser[]
  // Numeric ids of org owners/admins, so the view can badge them "Owner".
  // Empty when the admin list couldn't be read.
  ownerIds: Set<string>
  isLoading: boolean
  isError: boolean
  // classroom path -> resolved GitHub team slug (classroom.json.team.slug, else
  // the classroom50-<classroom> heuristic). The SAME slug teamMembersByClassroom
  // keys from, so optimistic team-cache writes on the Members page target the
  // cache this hook reads (a collided classroom's real slug can differ).
  teamSlugByClassroom: Map<string, string>
  // Per-classroom roster read failures (a 404/parse error contributes no
  // students rather than failing the whole page).
  notes: string[]
}

// Aggregate the org's members against every classroom roster: dedupe students,
// match to live members, classify discrepancies, surface per-student classroom
// access.
const useOrgMembersOverview = (org: string | undefined): OrgMembersOverview => {
  const client = useGitHubClient()

  const membersQuery = useQuery({
    ...orgMembersAllQuery(client, org ?? ""),
    enabled: Boolean(org),
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
        CONFIG_REPO,
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
        CONFIG_REPO,
        rosterPath(name),
        undefined,
        legacyRosterPath(name),
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

  // Live members of each classroom's `classroom50-<classroom>` team — the
  // enrollment source of truth, cross-referenced against CSV-derived access to
  // surface drift. Slug resolves from classroom.json when present (GitHub may
  // slugify a collided name differently), else the heuristic.
  const teamSlugs = useMemo(
    () =>
      classroomNames.map(
        (name, i) =>
          (metaQueries[i]?.data as Classroom | undefined)?.team?.slug ||
          classroomTeamSlugHeuristic(name),
      ),
    // metaQueries is a fresh array each render; depend on the stable signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [classroomNames, metaSignature],
  )

  const teamQueries = useQueries({
    queries: teamSlugs.map((slug) => ({
      ...teamMembersQuery(client, org ?? "", slug),
      enabled: Boolean(org && slug),
    })),
  })

  const teamSignature = teamQueries
    .map((q) => (q.data ? String(q.data.length) : "-"))
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

  // classroom -> set of live team-member id strings. Only classrooms whose team
  // query resolved are included; an unresolved/failed read is omitted so
  // aggregateOrgMembers treats it as "unknown" (never drift).
  const teamMembersByClassroom = useMemo(() => {
    const map = new Map<string, Set<string>>()
    classroomNames.forEach((name, i) => {
      const data = teamQueries[i]?.data
      if (data) {
        map.set(name, new Set(data.map((m) => String(m.id))))
      }
    })
    return map
    // teamQueries is a fresh array each render; depend on the stable signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classroomNames, teamSignature])

  const rows = useMemo(
    () => aggregateOrgMembers(members, rosters, teamMembersByClassroom),
    [members, rosters, teamMembersByClassroom],
  )

  const ownerIds = useMemo(
    () => memberIdSet(adminsQuery.data ?? []),
    [adminsQuery.data],
  )

  // classroom path -> resolved team slug, from the same teamSlugs array that
  // keys the team-member queries, so the Members page seeds/invalidates the
  // exact team cache this hook reads.
  const teamSlugByClassroom = useMemo(() => {
    const map = new Map<string, string>()
    classroomNames.forEach((name, i) => {
      map.set(name, teamSlugs[i])
    })
    return map
  }, [classroomNames, teamSlugs])

  const isLoading =
    membersQuery.isLoading ||
    metaQueries.some((q) => q.isLoading) ||
    rosterQueries.some((q) => q.isLoading)
  const isError = membersQuery.isError

  return {
    rows,
    members,
    ownerIds,
    isLoading,
    isError,
    teamSlugByClassroom,
    notes,
  }
}

export default useOrgMembersOverview
