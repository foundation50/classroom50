import { queryOptions } from "@tanstack/react-query"

import type { GitHubClient } from "../client"
import type { GitHubOrgInvitation, GitHubTeam } from "../types"
import { retryTransientGitHubError, tolerateGitHubError } from "../errors"
import { paginateAll } from "../paginate"
import { mapWithConcurrency } from "@/util/concurrency"
import { githubKeys } from "./keys"
import { REPO_READ_CONCURRENCY } from "./shared"

// Failed / expired org invitations (carry failed_at / failed_reason). Owner-only.
// Read org-wide, then attributed to a classroom team by
// getOrgFailedInvitationsForTeam (GitHub has no team-scoped failed endpoint).
export async function getOrgFailedInvitations(
  client: GitHubClient,
  org: string,
): Promise<GitHubOrgInvitation[]> {
  return paginateAll<GitHubOrgInvitation>(
    client,
    (page) => `/orgs/${org}/failed_invitations?per_page=100&page=${page}`,
  )
}

// Failed org invitations scoped to ONE classroom team. GitHub has no
// team-scoped failed endpoint, so this reads the org-wide failed list and keeps
// only invites whose team set (resolved per invite from invitation_teams_url)
// includes `teamSlug`. A per-invite teams read that fails drops that invite, so
// one bad read never leaks an unattributable invite onto the roster. Owner-only.
export async function getOrgFailedInvitationsForTeam(
  client: GitHubClient,
  org: string,
  teamSlug: string,
): Promise<GitHubOrgInvitation[]> {
  const failed = await getOrgFailedInvitations(client, org)
  const wantSlug = teamSlug.toLowerCase()
  const candidates = failed.filter((inv) => (inv.team_count ?? 0) > 0)
  const onTeam = await mapWithConcurrency(
    candidates,
    REPO_READ_CONCURRENCY,
    async (inv) => {
      if (!inv.invitation_teams_url) return false
      try {
        const teams = await client.request<GitHubTeam[]>(
          inv.invitation_teams_url,
        )
        return teams.some((t) => t.slug?.toLowerCase() === wantSlug)
      } catch {
        return false
      }
    },
  )
  return candidates.filter((_, i) => onTeam[i])
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

// Failed org invitations scoped to a classroom team. Owner-only, like the
// pending read; a transient 5xx self-heals. Attributes each org-wide failed
// invite to a team via its invitation_teams_url (see
// getOrgFailedInvitationsForTeam), so a failed invite for another classroom
// never surfaces on this roster.
export function teamFailedInvitationsQuery(
  client: GitHubClient,
  org: string,
  teamSlug: string,
) {
  return queryOptions({
    queryKey: githubKeys.teamFailedInvitations(org, teamSlug),
    queryFn: () => getOrgFailedInvitationsForTeam(client, org, teamSlug),
    enabled: Boolean(org && teamSlug),
    staleTime: 60 * 1000,
    retry: retryTransientGitHubError,
  })
}
