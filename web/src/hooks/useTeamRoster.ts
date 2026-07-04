import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import useGetClassroom from "@/hooks/useGetClassroom"
import useGetOrgInvitations from "@/hooks/useGetOrgInvitations"
import { teamMembersQuery } from "@/hooks/github/queries"
import { classroomTeamSlugHeuristic } from "@/util/onboarding"
import {
  buildTeamRoster,
  countByState,
  type TeamRosterRow,
  type TeamRosterRowState,
} from "@/util/teamRoster"
import type { Student } from "@/types/classroom"

export type UseTeamRosterResult = {
  rows: TeamRosterRow[]
  counts: Record<TeamRosterRowState, number>
  // The team-member fetch (the enrolled source of truth) is still resolving.
  isLoading: boolean
  // The team-member fetch (enrolled source of truth) failed for a reason other
  // than a missing team (listTeamMembers swallows 404 -> []). When true, the
  // roster couldn't be read and the view must show an error+retry instead of
  // the empty state, so a transient/permission failure isn't rendered as an
  // authoritative "nobody enrolled".
  isError: boolean
  // The classroom has zero team members AND zero pending invites — a brand-new
  // classroom nobody has joined yet.
  isEmpty: boolean
  // Pending invites couldn't be read (getOrgInvitations is owner-only; a
  // non-owner TA/instructor gets 403). The view then hides the pending section
  // and shows an "owners only" note instead of silently rendering zero pending.
  pendingHidden: boolean
  // The resolved team slug (classroom.json.team.slug, else classroom50-<c>).
  teamSlug: string
  // Re-run the team-member fetch (the enrolled source of truth) so an error
  // surface can offer a retry without a full page reload.
  refetch: () => void
}

// The teacher roster, driven by GitHub (team members + pending org invites),
// with students.csv joined only as optional display metadata. Resolves the team
// slug from classroom.json (fallback classroom50-<classroom>), matching the
// grade collector and Go download so all three consumers agree on the slug.
export function useTeamRoster(
  org: string,
  classroom: string,
  students: Student[],
): UseTeamRosterResult {
  const client = useGitHubClient()

  const { data: classroomJson } = useGetClassroom(org, classroom)
  const teamSlug =
    classroomJson?.team?.slug || classroomTeamSlugHeuristic(classroom)

  const {
    data: members,
    isLoading: membersLoading,
    isError: membersError,
    refetch: refetchMembers,
  } = useQuery({
    ...teamMembersQuery(client, org, teamSlug),
  })

  const {
    invitations,
    isLoading: invitesLoading,
    isForbidden: invitesForbidden,
  } = useGetOrgInvitations(org)

  const rows = useMemo(
    () =>
      buildTeamRoster({
        members: members ?? [],
        // A non-owner can't read invitations; pass none rather than a partial.
        invitations: invitesForbidden ? [] : invitations,
        students,
      }),
    [members, invitations, invitesForbidden, students],
  )

  const counts = useMemo(() => countByState(rows), [rows])

  // Enrolled rows come from team membership (readable by non-owners), so the
  // roster is usable even when invites are forbidden. Only wait on the invite
  // fetch when it's actually readable.
  const isLoading = membersLoading || (!invitesForbidden && invitesLoading)

  return {
    rows,
    counts,
    isLoading,
    isError: membersError,
    isEmpty: !isLoading && !membersError && rows.length === 0,
    pendingHidden: invitesForbidden,
    teamSlug,
    refetch: () => {
      void refetchMembers()
    },
  }
}
