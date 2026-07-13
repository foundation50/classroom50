import { useCallback, useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import useGetClassroom from "@/hooks/useGetClassroom"
import { useOrgRole } from "@/context/orgRole/OrgRoleProvider"
import { can } from "@/util/capabilities"
import {
  githubKeys,
  teamMembersQuery,
  teamInvitationsQuery,
  teamFailedInvitationsQuery,
  orgMembersAllQuery,
} from "@/hooks/github/queries"
import { GitHubAPIError } from "@/hooks/github/errors"
import { staffTeamName } from "@/hooks/github/mutations"
import { classroomTeamSlugHeuristic } from "@/util/orgMembership"
import {
  buildTeamRoster,
  countByState,
  teamMembersMissingFromCsv,
  rowsNeedingBackfill,
  type TeamRosterRow,
  type TeamRosterRowState,
  type RosterRole,
} from "@/util/teamRoster"
import { enrolledCountsByRole, type RoleCounts } from "@/util/rosterRoles"
import { memberIdentitySets } from "@/util/identity"
import type { Student } from "@/types/classroom"
import type { GitHubUser, GitHubOrgInvitation } from "@/hooks/github/types"

// Pending is owner-only. The manageOrg capability is the authoritative owner
// check (a non-owner can't read invitations at all), so we hide all pending
// behind one "owners only" note. A single team's definitive 403 on the student
// pending read also hides (a scope gap the owner can't fix here); a per-STAFF
// team 403 is NOT a hide-all — it just omits that one team's pending (handled at
// the call site via `data ?? []`).
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
  // Pending invites couldn't be read (owner-only; a non-owner TA/instructor
  // can't read them). The view then hides the pending section and shows an
  // "owners only" note instead of rendering zero pending.
  pendingHidden: boolean
  // Failed/expired invitations scoped to THIS classroom team (owner-only, like
  // pending). Empty when pendingHidden (a non-owner can't read them). Surfaced
  // so the roster can show a "needs re-invite" section for invites GitHub
  // couldn't deliver.
  failedInvitations: GitHubOrgInvitation[]
  // The resolved team slug (classroom.json.team.slug, else classroom50-<c>).
  teamSlug: string
  // Resolved team slug per role, so the detail view can link each role a member
  // actually holds to its real team (student -> classroom team, instructor/ta ->
  // the staff team) rather than assuming everyone is on the student team.
  teamSlugByRole: Record<RosterRole, string>
  // Count of team members with no roster.csv row — the exact set "Sync roster"
  // appends. 0 = in sync (button disabled, "In sync"); >0 = drift the teacher
  // can sync (auto-synced on open).
  csvMissingCount: number
  // Lowercased logins of team members with no roster.csv row — used to skip a
  // just-unenrolled member (team-drop failed) from the automatic CSV backfill.
  csvMissingLogins: string[]
  // Count of existing CSV rows that are stale against team membership (blank
  // github_id or a role differing from the team). Sync backfills these; the
  // view uses it (with csvMissingCount) to decide whether a sync is worthwhile.
  backfillNeededCount: number
  // Lowercased logins of the stale rows, so the auto-sync trigger can drop a
  // suppressed (just-unenrolled) login before deciding to sync — mirroring
  // csvMissingLogins, so both drift terms agree on who is suppressed.
  backfillNeededLogins: string[]
  // Whether org membership was readable, so the view can gate the in-org
  // "needs attention" filter option (no such rows exist when membership is
  // unknown — those rows are suppressed).
  orgMembersKnown: boolean
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
  const { orgRole } = useOrgRole()
  // Team invitations are owner-only (like org invitations). Gate the reads on
  // the manageOrg capability so a non-owner doesn't fire a guaranteed 403.
  const isOwner = can("manageOrg", { orgRole })

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

  // Student pending invitations, TEAM-SCOPED (owner-only, like the staff teams).
  // GitHub lists a pending invite under a team only when that team was on the
  // invite, and every classroom student invite carries the classroom team — so
  // this scopes pending to THIS classroom, unlike the org-wide list which leaked
  // one org invite onto every classroom's roster (#236). Gated on ownership so a
  // non-owner never fires the guaranteed 403.
  const studentInvitesQuery = useQuery({
    ...teamInvitationsQuery(client, org, teamSlug),
    enabled: Boolean(org && teamSlug) && isOwner,
  })
  // Failed/expired invites, scoped to this classroom team (see
  // getOrgFailedInvitationsForTeam). Owner-only, same gate.
  const studentFailedInvitesQuery = useQuery({
    ...teamFailedInvitationsQuery(client, org, teamSlug),
    enabled: Boolean(org && teamSlug) && isOwner,
  })

  // Team-scoped pending invitations for the staff teams (owner-only, like org
  // invitations). Gated on org ownership so a non-owner never fires the 403;
  // 404 (uncreated team) -> [].
  const instructorInvitesQuery = useQuery({
    ...teamInvitationsQuery(client, org, instructorSlug),
    enabled: Boolean(org && instructorSlug) && isOwner,
  })
  const taInvitesQuery = useQuery({
    ...teamInvitationsQuery(client, org, taSlug),
    enabled: Boolean(org && taSlug) && isOwner,
  })

  const invitations = useMemo(
    () => studentInvitesQuery.data ?? [],
    [studentInvitesQuery.data],
  )
  const failedInvitations = useMemo(
    () => studentFailedInvitesQuery.data ?? [],
    [studentFailedInvitesQuery.data],
  )

  // All active org members (shared cache with the Org Members page). Used only
  // to classify a roster.csv row on no team as in-org (assign a role) vs
  // not-in-org (invite). A failed/forbidden read leaves orgMembersKnown false,
  // so buildTeamRoster suppresses those needs-attention rows rather than
  // guessing — the roster degrades to the pure team-driven view, never errors.
  const orgMembersQuery = useQuery(orgMembersAllQuery(client, org))
  const orgMembersKnown = orgMembersQuery.isSuccess
  const { orgMemberIds, orgMemberLogins } = useMemo(() => {
    const { ids, logins } = memberIdentitySets(orgMembersQuery.data ?? [])
    return { orgMemberIds: ids, orgMemberLogins: logins }
  }, [orgMembersQuery.data])

  // Pending is owner-only. A definitive non-owner is hidden without a request;
  // an owner whose student pending read returns a definitive 403 (e.g. a token
  // scope gap) is also hidden. A transient error is NOT a hide (it self-heals
  // and folds into isError below).
  const studentInvitesForbidden =
    studentInvitesQuery.error instanceof GitHubAPIError &&
    studentInvitesQuery.error.isForbidden
  const pendingHidden = computePendingHidden(
    !isOwner || studentInvitesForbidden,
  )

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
        orgMemberIds,
        orgMemberLogins,
        orgMembersKnown,
        pendingHidden,
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
      orgMemberIds,
      orgMemberLogins,
      orgMembersKnown,
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

  // Rows already in the CSV but stale against team membership (blank github_id
  // or a role that differs from the team's) — the login-only row case.
  // These need the same sync backfill but aren't "missing", so they must feed
  // the sync trigger separately, else a login-only row would never converge.
  const backfillNeeded = useMemo(
    () =>
      rowsNeedingBackfill(
        members ?? [],
        { instructor: instructorMembers ?? [], ta: taMembers ?? [] },
        students,
      ),
    [members, instructorMembers, taMembers, students],
  )
  const backfillNeededCount = backfillNeeded.length
  // Lowercased logins of the stale rows, so the auto-sync trigger can drop a
  // just-unenrolled member the same way it does for csvMissingLogins — a
  // suppressed login's still-present stale row must not re-fire a resurrecting
  // sync during the eventual-consistency window.
  const backfillNeededLogins = useMemo(
    () => backfillNeeded.map((s) => s.username.trim().toLowerCase()),
    [backfillNeeded],
  )

  // Any team-member fetch (student or staff) failing for a non-404 reason is a
  // real error — surface it rather than rendering a partial roster as "empty".
  // The student invitation reads count too when READABLE (an owner): a transient
  // 5xx returns an empty list that would otherwise render as authoritative "zero
  // pending" / "zero failed" for an owner who does have invites — so both the
  // pending and the failed read fold in. A non-owner's definitive 403 is
  // `pendingHidden`, not an error (pending is hidden by design), so it's
  // excluded.
  const isError = Boolean(
    membersError ||
    instructorMembersQuery.isError ||
    taMembersQuery.isError ||
    (!pendingHidden &&
      (studentInvitesQuery.isError || studentFailedInvitesQuery.isError)),
  )

  // Wait on every team-member fetch (student + staff) so the roster appears
  // atomically rather than flashing empty then popping staff in. The invite
  // fetch is only awaited when readable (non-owners skip it). Staff member
  // fetches 404 fast for an uncreated team, so this doesn't stall a class with
  // no staff teams.
  const isLoading =
    membersLoading ||
    instructorMembersQuery.isLoading ||
    taMembersQuery.isLoading ||
    (!pendingHidden && studentInvitesQuery.isLoading)

  return {
    rows,
    counts,
    roleCounts,
    isLoading,
    isError,
    isEmpty: !isLoading && !isError && rows.length === 0,
    pendingHidden,
    // Owner-only, like pending — hide wholesale for a non-owner.
    failedInvitations: pendingHidden ? [] : failedInvitations,
    teamSlug,
    teamSlugByRole: {
      student: teamSlug,
      instructor: instructorSlug,
      ta: taSlug,
    },
    csvMissingCount,
    csvMissingLogins,
    backfillNeededCount,
    backfillNeededLogins,
    orgMembersKnown,
    // isError folds in the staff-member fetches too, so a retry must re-run
    // every team-member query (student + instructor + ta), not just the
    // student one — otherwise a staff-team failure stays stuck in error. Also
    // refetch the staff invitation queries so a recovered permission/transient
    // failure repopulates pending.
    refetch: () => {
      void refetchMembers()
      void instructorMembersQuery.refetch()
      void taMembersQuery.refetch()
      void studentInvitesQuery.refetch()
      void studentFailedInvitesQuery.refetch()
      void instructorInvitesQuery.refetch()
      void taInvitesQuery.refetch()
      void orgMembersQuery.refetch()
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
// with no pending invite, so without the seed the just-enrolled member would not
// render until the refetch lands. Dedup by id; the refetch replaces the
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
