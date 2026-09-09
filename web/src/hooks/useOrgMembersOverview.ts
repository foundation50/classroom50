import { useMemo } from "react"
import { useQuery, useQueries } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  csvFileQuery,
  jsonFileQuery,
  orgAdminsQuery,
  orgFailedInvitationsQuery,
  orgInvitationsQuery,
  orgMembersAllQuery,
  teamMembersQuery,
} from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"
import { classroomFilePath, rosterPath } from "@/util/configRepoPaths"
import useGetClasses from "@/hooks/useGetClasses"
import { classroomTeamSlug } from "@/util/teamSlug"
import { toStudent } from "@/util/roster"
import {
  isClassroomArchived,
  type Classroom,
  type Student,
} from "@/types/classroom"
import {
  aggregateOrgMembers,
  orphanedFailedInvitations,
  type OrgMemberRow,
  type OrphanedFailedInvitation,
} from "@/util/orgMembers"
import { memberIdSet } from "@/util/identity"
import type { GitHubUser } from "@/github-core/types"

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
  // Retry for the members read behind `isError` (the meta/roster enrichment
  // queries degrade independently).
  refetchMembers: () => void
  // classroom path -> resolved GitHub team slug (classroom.json.team.slug, else
  // the derived classroomTeamSlug). The SAME slug teamMembersByClassroom
  // keys from, so optimistic team-cache writes on the Members page target the
  // cache this hook reads (a collided classroom's real slug can differ).
  teamSlugByClassroom: Map<string, string>
  // classroom path -> display name from classroom.json. Absent while metadata
  // hasn't loaded (or carries no name) — callers fall back to the path.
  displayNameByClassroom: Map<string, string>
  // Classrooms whose roster.csv couldn't be read (a 404/parse error
  // contributes no students rather than failing the whole page). The page
  // renders the note, so no English is assembled here.
  rosterReadFailures: string[]
  // GitHub's failed/expired invitations that no classroom roster or member
  // explains (see orphanedFailedInvitations). Owner-only read; empty while
  // loading or when unreadable. Only meaningful once every roster has loaded:
  // a roster still in flight would make its students look like orphans.
  orphanedFailedInvitations: OrphanedFailedInvitation[]
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

  // The org's invitation lists (owner-only; this page is owner-gated). Pending
  // decides "Invitation pending" vs "Unlinked"/"Not in organization"; failed
  // explains a stranded row ("Invitation expired") and feeds the orphan notice.
  const pendingInvitesQuery = useQuery({
    ...orgInvitationsQuery(client, org ?? ""),
    enabled: Boolean(org),
  })
  const failedInvitesQuery = useQuery({
    ...orgFailedInvitationsQuery(client, org ?? ""),
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
        classroomFilePath(name),
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
  // slugify a collided name differently), else the derived classroomTeamSlug.
  const teamSlugs = useMemo(
    () =>
      classroomNames.map(
        (name, i) =>
          (metaQueries[i]?.data as Classroom | undefined)?.team?.slug ||
          classroomTeamSlug(name),
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

  const { rosters, rosterReadFailures } = useMemo(() => {
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
    return {
      rosters: collected.map(({ classroom, archived, students }) => ({
        classroom,
        archived,
        students,
      })),
      rosterReadFailures: collected
        .filter((c) => c.failed)
        .map((c) => c.classroom),
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

  // `pending` is passed only once loaded (see OrgInvitationLists); a failed
  // pending read leaves it undefined, so identity-less rows read as unlinked
  // rather than as a pending invitation nobody verified.
  const pendingInvitations = pendingInvitesQuery.data
  const failedInvitations = failedInvitesQuery.data
  const rows = useMemo(
    () =>
      aggregateOrgMembers(members, rosters, teamMembersByClassroom, {
        pending: pendingInvitations,
        failed: failedInvitations,
      }),
    [
      members,
      rosters,
      teamMembersByClassroom,
      pendingInvitations,
      failedInvitations,
    ],
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

  const displayNameByClassroom = useMemo(() => {
    const map = new Map<string, string>()
    classroomNames.forEach((name, i) => {
      const displayName = (
        metaQueries[i]?.data as Classroom | undefined
      )?.name?.trim()
      if (displayName) map.set(name, displayName)
    })
    return map
    // metaQueries is a fresh array each render; depend on the stable signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classroomNames, metaSignature])

  // The pending read is awaited too: a row's standing depends on it, and
  // rendering before it lands would flash "Unlinked" over a pending student.
  const isLoading =
    membersQuery.isLoading ||
    pendingInvitesQuery.isLoading ||
    metaQueries.some((q) => q.isLoading) ||
    rosterQueries.some((q) => q.isLoading)
  const isError = membersQuery.isError

  // Withheld until every roster read has settled (success or failure): an
  // orphan is "on no roster", which is unknowable while one is still loading.
  // A roster that FAILED to read is excluded too, since its students would
  // wrongly look orphaned; the page already notes that roster is out.
  const rostersSettled =
    !isLoading && rosterQueries.every((q) => q.isSuccess || q.isError)
  const anyRosterFailed = rosterQueries.some((q) => q.isError)
  const orphans = useMemo(
    () =>
      rostersSettled && !anyRosterFailed && failedInvitesQuery.data
        ? orphanedFailedInvitations(failedInvitesQuery.data, members, rosters)
        : [],
    [
      rostersSettled,
      anyRosterFailed,
      failedInvitesQuery.data,
      members,
      rosters,
    ],
  )

  return {
    rows,
    members,
    ownerIds,
    isLoading,
    isError,
    refetchMembers: () => {
      void membersQuery.refetch()
    },
    teamSlugByClassroom,
    displayNameByClassroom,
    rosterReadFailures,
    orphanedFailedInvitations: orphans,
  }
}

export default useOrgMembersOverview
