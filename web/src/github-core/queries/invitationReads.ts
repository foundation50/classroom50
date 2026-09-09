import { queryOptions } from "@tanstack/react-query"

import type { GitHubClient } from "../client"
import type { GitHubOrgInvitation } from "../types"
import { retryTransientGitHubError, tolerateGitHubError } from "../errors"
import { paginateAll } from "../paginate"
import { githubKeys } from "./keys"

// Failed org invitations (GET /orgs/{org}/failed_invitations). Owner-only.
// Verified against a live org (2026-09-09): an invitation nobody accepted for 7
// days lands here with failed_reason "Invitation expired. User did not accept
// this invite for 7 days", and it is gone from the pending lists. Its
// `invitation_teams_url` 404s once failed (even with team_count 1), so a failed
// invite CANNOT be attributed to a classroom through its teams. Attribution
// happens in buildTeamRoster instead, by matching the invite's email/login to
// this classroom's roster.csv rows (see BuildTeamRosterInput.failedInvitations).
export async function getOrgFailedInvitations(
  client: GitHubClient,
  org: string,
): Promise<GitHubOrgInvitation[]> {
  return paginateAll<GitHubOrgInvitation>(
    client,
    (page) => `/orgs/${org}/failed_invitations?per_page=100&page=${page}`,
  )
}

// PENDING org invitations across all pages (GET /orgs/{org}/invitations).
// Owner-only. The liveness source for the invite lifecycle: the invite-team GC
// (a member-less invite team whose (classroom, email) matches no pending
// invitation is stale — cancelled or expired) and the roster sync's dead
// email-row confirmation. NOT error-tolerated — a degraded read must fail
// closed rather than read as "no live invites" and delete every pending team or
// drop every pending row.
export async function listOrgInvitations(
  client: GitHubClient,
  org: string,
): Promise<GitHubOrgInvitation[]> {
  return paginateAll<GitHubOrgInvitation>(
    client,
    (page) =>
      `/orgs/${encodeURIComponent(org)}/invitations?per_page=100&page=${page}`,
  )
}

// List a team's pending invitations across all pages (GET
// /orgs/{org}/teams/{slug}/invitations). Unlike org-level invitations, these are
// team-scoped, so a pending invite can be attributed to the classroom role whose
// team lists it. 404 (team not created yet) -> [] like listTeamMembers; 403
// (owner-only) propagates so callers can hide pending. `login` is null for an
// email-only invitee (tag by email then).
export async function listTeamInvitations(
  client: GitHubClient,
  org: string,
  teamSlug: string,
): Promise<GitHubOrgInvitation[]> {
  return tolerateGitHubError(
    () =>
      paginateAll<GitHubOrgInvitation>(
        client,
        (page) =>
          `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(
            teamSlug,
          )}/invitations?per_page=100&page=${page}`,
      ),
    [],
  )
}

export function teamInvitationsQuery(
  client: GitHubClient,
  org: string,
  teamSlug: string,
) {
  return queryOptions({
    queryKey: githubKeys.teamInvitations(org, teamSlug),
    queryFn: () => listTeamInvitations(client, org, teamSlug),
    enabled: Boolean(org && teamSlug),
    staleTime: 60 * 1000,
    // 403 (owner-only) / 404 stay definitive so pendingHidden / [] resolve at
    // once; a transient 5xx/429 self-heals rather than silently rendering zero
    // pending for the role with no retry (the query error isn't in isError).
    retry: retryTransientGitHubError,
  })
}

// Org-wide failed invitations. Owner-only, like the pending read; a transient
// 5xx self-heals. The roster attributes entries to a classroom by roster.csv
// match (see getOrgFailedInvitations), so one shared cache serves every
// classroom of the org.
export function orgFailedInvitationsQuery(client: GitHubClient, org: string) {
  return queryOptions({
    queryKey: githubKeys.orgFailedInvitations(org),
    queryFn: () => getOrgFailedInvitations(client, org),
    enabled: Boolean(org),
    staleTime: 60 * 1000,
    retry: retryTransientGitHubError,
  })
}
