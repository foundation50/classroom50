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
import { enrolledCountsByRole, type RoleCounts } from "@/util/rosterRoles"
import type { Student } from "@/types/classroom"
import type { GitHubUser } from "@/hooks/github/types"

// Pending is owner-only, and the ORG-level invitations endpoint is the
// authoritative owner check: a non-owner gets 403 there and we hide all pending
// behind one "owners only" note. A single STAFF team's 403 is NOT a hide-all
// signal — when org invitations are readable the viewer is an owner, so a
// per-team 403 (or any per-team error) just omits that one team's pending
// (handled at the call site via `data ?? []`) rather than blacking out the
// readable org + sibling-team pending too.
export function computePendingHidden(invitesForbidden: boolean): boolean {
  return invitesForbidden
}

export type UseTeamRosterResult = {
  rows: TeamRosterRow[]
  counts: Record<TeamRosterRowState, number>
  // Enrolled (active-member) head counts by role for the header: how many
  // students, instructors, and TAs are actually on a team. A person on two
  // teams counts toward each of their roles (tallies, not a partition).
  roleCounts: RoleCounts
  // The team-member fetch (the enrolled source of truth) is still resolving.
  isLoading: boolean
  // The team-member fetch failed for a reason other than a missing team
  // (listTeamMembers swallows 404 -> []). Covers the STUDENT team and the two
  // STAFF teams, so a transient 5xx / 403 on any of them surfaces error+retry
  // instead of silently rendering "nobody enrolled" / "no staff".
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
  // Count of team members with no roster.csv row — the exact set "Sync roster"
  // appends. 0 = in sync (button disabled, "In sync"); >0 = drift the teacher
  // can sync (auto-synced on open). Opposite direction from `not_in_org` (on
  // CSV, not on team), which sync can't fix.
  csvMissingCount: number
  // Lowercased logins of team members with no roster.csv row — used to skip a
  // just-unenrolled member (team-drop failed) from the automatic CSV backfill.
  csvMissingLogins: string[]
  // Rostered students who are `not_in_org` (on roster.csv with a username but
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
// with roster.csv joined only as optional display metadata. Resolves the team
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
  // uncreated staff team reads as "no staff". A non-404 failure (transient 5xx,
  // 403) is a real error and is folded into isError below — staff data gets the
  // same failure semantics as the student roster, never a silent "no staff".
  const instructorMembersQuery = useQuery(
    teamMembersQuery(client, org, instructorSlug),
  )
  const taMembersQuery = useQuery(teamMembersQuery(client, org, taSlug))
  const instructorMembers = instructorMembersQuery.data
  const taMembers = taMembersQuery.data

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

  const pendingHidden = computePendingHidden(invitesForbidden)

  const rows = useMemo(
    () =>
      buildTeamRoster({
        members: members ?? [],
        // A non-owner can't read invitations; pass none rather than a partial.
        // (org invitations forbidden => pendingHidden => the whole pending
        // section collapses to the owners-only note.)
        invitations: pendingHidden ? [] : invitations,
        staffMembers: {
          instructor: instructorMembers ?? [],
          ta: taMembers ?? [],
        },
        // Each staff team's pending is independent: an owner who can read org
        // invitations but hits a per-team 403/error still sees the readable
        // teams' pending — that team's `data` is undefined -> [] (omitted), not
        // a hide-all. Zeroed wholesale only when pendingHidden (non-owner).
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
  // Enrolled head counts by role for the header (students / instructors / TAs).
  const roleCounts = useMemo(() => enrolledCountsByRole(rows), [rows])

  // CSV drift / reconcile: role is now recorded metadata, so every classroom
  // member (student + instructor + ta) belongs in roster.csv. Count all three
  // teams against the CSV so auto-sync also populates a staff-only classroom
  // (an instructor/TA with no students still needs a roster.csv row).
  const allTeamMembers = useMemo(() => {
    const byId = new Map<number, GitHubUser>()
    for (const m of [
      ...(members ?? []),
      ...(instructorMembers ?? []),
      ...(taMembers ?? []),
    ]) {
      if (!byId.has(m.id)) byId.set(m.id, m)
    }
    return [...byId.values()]
  }, [members, instructorMembers, taMembers])
  const csvMissing = useMemo(
    () => teamMembersMissingFromCsv(allTeamMembers, students),
    [allTeamMembers, students],
  )
  const csvMissingCount = csvMissing.length
  // Lowercased logins of those csv-missing team members, so the view can skip a
  // just-unenrolled member (whose best-effort team-drop failed) from the
  // automatic backfill rather than re-appending the student it just removed.
  const csvMissingLogins = useMemo(
    () => csvMissing.map((m) => m.login.toLowerCase()),
    [csvMissing],
  )

  // Rostered `not_in_org` usernames — what auto-reconcile tries to team-add
  // (reconcile skips any that aren't active org members). Memoized so the join
  // key stays a stable string list rather than a fresh array every render.
  const notInOrg = useMemo(() => notInOrgUsernames(rows), [rows])

  // Any team-member fetch (student or staff) failing for a non-404 reason is a
  // real error — surface it rather than rendering a partial roster as "empty".
  const isError =
    membersError || instructorMembersQuery.isError || taMembersQuery.isError

  // Wait on every team-member fetch (student + staff) so the roster appears
  // atomically rather than flashing empty then popping staff in. The invite
  // fetch is only awaited when readable (non-owners skip it). Staff member
  // fetches 404 fast for an uncreated team, so this doesn't stall a class with
  // no staff teams.
  const isLoading =
    membersLoading ||
    instructorMembersQuery.isLoading ||
    taMembersQuery.isLoading ||
    (!pendingHidden && invitesLoading)

  return {
    rows,
    counts,
    roleCounts,
    isLoading,
    isError,
    isEmpty: !isLoading && !isError && rows.length === 0,
    pendingHidden,
    teamSlug,
    csvMissingCount,
    csvMissingLogins,
    notInOrgUsernames: notInOrg,
    // isError folds in the staff-member fetches too, so a retry must re-run
    // every team-member query (student + instructor + ta), not just the
    // student one — otherwise a staff-team failure stays stuck in error. Also
    // refetch the staff invitation queries so a recovered permission/transient
    // failure repopulates pending.
    refetch: () => {
      void refetchMembers()
      void instructorMembersQuery.refetch()
      void taMembersQuery.refetch()
      void instructorInvitesQuery.refetch()
      void taInvitesQuery.refetch()
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
