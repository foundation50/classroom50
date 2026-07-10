import { useCallback, useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import useGetClassroom from "@/hooks/useGetClassroom"
import useGetOrgInvitations from "@/hooks/useGetOrgInvitations"
import {
  githubKeys,
  teamMembersQuery,
  teamInvitationsQuery,
} from "@/hooks/github/queries"
import { staffTeamName } from "@/hooks/github/mutations"
import { classroomTeamSlugHeuristic } from "@/util/orgMembership"
import {
  buildTeamRoster,
  countByState,
  notInOrgUsernames,
  teamMembersMissingFromCsv,
  type TeamRosterRow,
  type TeamRosterRowState,
} from "@/util/teamRoster"
import { GitHubAPIError } from "@/hooks/github/errors"
import type { Student } from "@/types/classroom"
import type { GitHubUser } from "@/hooks/github/types"

export type UseTeamRosterResult = {
  rows: TeamRosterRow[]
  counts: Record<TeamRosterRowState, number>
  // The team-member fetch (the enrolled source of truth) is still resolving.
  isLoading: boolean
  // The team-member fetch (enrolled source of truth) failed for a reason other
  // than a missing team (listTeamMembers swallows 404 -> []). When true, the
  // view must show error+retry instead of the empty state, so a
  // transient/permission failure isn't rendered as "nobody enrolled".
  isError: boolean
  // The classroom has zero team members AND zero pending invites — a brand-new
  // classroom nobody has joined yet.
  isEmpty: boolean
  // Pending invites couldn't be read (getOrgInvitations is owner-only; a
  // non-owner TA/instructor gets 403). The view then hides the pending section
  // and shows an "owners only" note instead of rendering zero pending.
  pendingHidden: boolean
  // The resolved team slug (classroom.json.team.slug, else classroom50-<c>).
  teamSlug: string
  // Count of team members with no students.csv row — the exact set "Sync roster"
  // appends. 0 = in sync (button disabled, "In sync"); >0 = drift the teacher
  // can sync (auto-synced on open). Opposite direction from `not_in_org` (on
  // CSV, not on team), which sync can't fix.
  csvMissingCount: number
  // Rostered students who are `not_in_org` (on students.csv with a username but
  // not a team/org member and not a pending invite) — the usernames
  // auto-reconcile feeds to reconcileTeamFromOrgMembers. It team-adds the ones
  // that are in fact active org members (native invite / SSO) and skips the
  // rest, which stay `not_in_org` and are highlighted for invite/removal.
  notInOrgUsernames: string[]
  // Re-run the team-member fetch so an error surface can offer a retry without a
  // full page reload.
  refetch: () => void
}

// The teacher roster, driven by GitHub (team members + pending org invites),
// with students.csv joined only as optional display metadata. Resolves the team
// slug from classroom.json (fallback classroom50-<classroom>) so the grade
// collector, Go download, and this view agree on the slug.
export function useTeamRoster(
  org: string,
  classroom: string,
  students: Student[],
): UseTeamRosterResult {
  const client = useGitHubClient()

  const { data: classroomJson } = useGetClassroom(org, classroom)
  const teamSlug =
    classroomJson?.team?.slug || classroomTeamSlugHeuristic(classroom)
  // Staff team slugs: prefer the classroom's stored slug, else the heuristic
  // (same precedence as the student slug above).
  const instructorSlug =
    classroomJson?.teams?.instructor?.slug ||
    staffTeamName(classroom, "instructor")
  const taSlug =
    classroomJson?.teams?.ta?.slug || staffTeamName(classroom, "ta")

  const {
    data: members,
    isLoading: membersLoading,
    isError: membersError,
    refetch: refetchMembers,
  } = useQuery({
    ...teamMembersQuery(client, org, teamSlug),
  })

  // Staff-team members. A missing team 404s -> [] (listTeamMembers), so an
  // uncreated staff team reads as "no staff", never an error.
  const { data: instructorMembers } = useQuery(
    teamMembersQuery(client, org, instructorSlug),
  )
  const { data: taMembers } = useQuery(teamMembersQuery(client, org, taSlug))

  const {
    invitations,
    isLoading: invitesLoading,
    isForbidden: invitesForbidden,
  } = useGetOrgInvitations(org)

  // Team-scoped pending invitations for the staff teams (owner-only, like org
  // invitations). 403 marks pending hidden; 404 (uncreated team) -> [].
  const instructorInvitesQuery = useQuery(
    teamInvitationsQuery(client, org, instructorSlug),
  )
  const taInvitesQuery = useQuery(teamInvitationsQuery(client, org, taSlug))

  const isForbidden = (err: unknown): boolean =>
    err instanceof GitHubAPIError && err.isForbidden
  // Pending is owner-only across all sources; hide it if ANY pending fetch is
  // forbidden so the view shows the single "owners only" note rather than a
  // partial pending list.
  const pendingHidden =
    invitesForbidden ||
    isForbidden(instructorInvitesQuery.error) ||
    isForbidden(taInvitesQuery.error)

  const rows = useMemo(
    () =>
      buildTeamRoster({
        members: members ?? [],
        // A non-owner can't read invitations; pass none rather than a partial.
        invitations: pendingHidden ? [] : invitations,
        staffMembers: {
          instructor: instructorMembers ?? [],
          ta: taMembers ?? [],
        },
        staffInvitations: pendingHidden
          ? {}
          : {
              instructor: instructorInvitesQuery.data ?? [],
              ta: taInvitesQuery.data ?? [],
            },
        students,
      }),
    [
      members,
      instructorMembers,
      taMembers,
      invitations,
      instructorInvitesQuery.data,
      taInvitesQuery.data,
      pendingHidden,
      students,
    ],
  )

  const counts = useMemo(() => countByState(rows), [rows])

  // CSV drift / reconcile are STUDENT-roster concepts: a staffer is never
  // synced into students.csv, so count only the student team against the CSV.
  const csvMissingCount = useMemo(
    () => teamMembersMissingFromCsv(members ?? [], students).length,
    [members, students],
  )

  // Rostered `not_in_org` usernames — what auto-reconcile tries to team-add
  // (reconcile skips any that aren't active org members). Memoized so the join
  // key stays a stable string list rather than a fresh array every render.
  const notInOrg = useMemo(() => notInOrgUsernames(rows), [rows])

  // Enrolled rows come from team membership (readable by non-owners), so the
  // roster is usable even when invites are forbidden. Wait on the invite fetch
  // only when it's readable.
  const isLoading = membersLoading || (!pendingHidden && invitesLoading)

  return {
    rows,
    counts,
    isLoading,
    isError: membersError,
    isEmpty: !isLoading && !membersError && rows.length === 0,
    pendingHidden,
    teamSlug,
    csvMissingCount,
    notInOrgUsernames: notInOrg,
    refetch: () => {
      void refetchMembers()
    },
  }
}

// Invalidate the team-members query that drives the enrolled roster (slug
// resolved as in useTeamRoster). Any mutation changing classroom-team
// membership (enroll/unenroll/match) must call this, or the change only shows
// after the members query's staleTime lapses.
export function useInvalidateTeamRoster(
  org: string,
  classroom: string,
): () => void {
  const queryClient = useQueryClient()
  const { data: classroomJson } = useGetClassroom(org, classroom)
  const teamSlug =
    classroomJson?.team?.slug || classroomTeamSlugHeuristic(classroom)

  return useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: githubKeys.teamMembers(org, teamSlug),
    })
  }, [queryClient, org, teamSlug])
}

// Minimal identity to seed a member into the team-members cache; buildTeamRoster
// reads only id/login/avatar, and the refetch fills the rest of GitHubUser.
export type OptimisticMember = {
  id: number
  login: string
  avatar_url?: string
}

// Optimistically add a just-enrolled member to the team-members cache, then
// invalidate to reconcile. Enrolling an already-active org member team-adds them
// with no pending invite, so without the seed buildTeamRoster flashes the row as
// "not_in_org" until the refetch lands. Dedup by id; the refetch replaces the
// stub (or drops it if the add didn't land). No-ops a blank/invalid id.
export function useSeedTeamMember(
  org: string,
  classroom: string,
): (member: OptimisticMember) => void {
  const queryClient = useQueryClient()
  const { data: classroomJson } = useGetClassroom(org, classroom)
  const teamSlug =
    classroomJson?.team?.slug || classroomTeamSlugHeuristic(classroom)

  return useCallback(
    (member: OptimisticMember) => {
      const key = githubKeys.teamMembers(org, teamSlug)
      if (!Number.isFinite(member.id) || member.id <= 0 || !member.login) {
        void queryClient.invalidateQueries({ queryKey: key })
        return
      }
      queryClient.setQueryData<GitHubUser[]>(key, (current) => {
        const list = current ?? []
        if (list.some((m) => m.id === member.id)) return list
        const stub = {
          login: member.login,
          id: member.id,
          avatar_url: member.avatar_url ?? "",
          html_url: "",
          name: null,
          email: null,
          bio: null,
          permissions: {
            admin: false,
            pull: true,
            maintain: false,
            push: false,
          },
        } satisfies GitHubUser
        return [...list, stub]
      })
      void queryClient.invalidateQueries({ queryKey: key })
    },
    [queryClient, org, teamSlug],
  )
}
