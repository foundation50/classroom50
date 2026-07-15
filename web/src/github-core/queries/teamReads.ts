import { queryOptions } from "@tanstack/react-query"

import type { GitHubClient } from "../client"
import type { GitHubTeam, GitHubUser, MyTeam } from "../types"
import { classroomTeamSlug } from "@/util/teamSlug"
import {
  GitHubAPIError,
  retryTransientGitHubError,
  tolerateGitHubError,
} from "../errors"
import { createTeam } from "../teamWrites"
import { paginateAll } from "../paginate"
import { githubKeys } from "./keys"

export async function getTeam(
  client: GitHubClient,
  org: string,
  classroom: string,
) {
  const teamSlug = classroomTeamSlug(classroom)

  return tolerateGitHubError(
    () => client.request<GitHubTeam>(`/orgs/${org}/teams/${teamSlug}`),
    null,
  )
}

// Whether the classroom team already has access to a repo (the in-org private
// template). 2xx = has access, 404 = doesn't; other errors propagate so a
// transient failure isn't misread as "no access".
export async function teamHasRepoAccess(
  client: GitHubClient,
  input: { org: string; classroom: string; owner: string; repo: string },
): Promise<boolean> {
  const { org, classroom, owner, repo } = input
  const teamSlug = classroomTeamSlug(classroom)

  return tolerateGitHubError(async () => {
    await client.request(
      `/orgs/${org}/teams/${teamSlug}/repos/${owner}/${repo}`,
    )
    return true
  }, false)
}

export async function ensureTeam(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<GitHubTeam> {
  const existingTeam = await getTeam(client, org, classroom)

  if (existingTeam) return existingTeam

  try {
    return await createTeam(client, { org, name: classroomTeamSlug(classroom) })
  } catch (error) {
    if (error instanceof GitHubAPIError && error.status === 422) {
      const team = await getTeam(client, org, classroom)

      if (team) return team
    }

    throw error
  }
}

// List a team's members across all pages. 404 (team doesn't exist yet) returns
// [] so a classroom whose staff team hasn't been created reads as "no members".
export async function listTeamMembers(
  client: GitHubClient,
  org: string,
  teamSlug: string,
): Promise<GitHubUser[]> {
  return tolerateGitHubError(
    () =>
      paginateAll<GitHubUser>(
        client,
        (page) =>
          `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(
            teamSlug,
          )}/members?per_page=100&page=${page}`,
      ),
    [],
  )
}

export function teamMembersQuery(
  client: GitHubClient,
  org: string,
  teamSlug: string,
) {
  return queryOptions({
    queryKey: githubKeys.teamMembers(org, teamSlug),
    queryFn: () => listTeamMembers(client, org, teamSlug),
    enabled: Boolean(org && teamSlug),
    staleTime: 60 * 1000,
  })
}

// Every team in the org across all pages (GET /orgs/{org}/teams). Owner/member
// visibility applies (secret teams only listed for members who can see them).
// Used to cross-reference each `classroom50-<classroom>` team's live membership
// against CSV-derived classroom access, surfacing drift on the Members page.
// 404 (no access) -> [] so the page degrades to CSV-only display.
export async function listOrgTeams(
  client: GitHubClient,
  org: string,
): Promise<GitHubTeam[]> {
  return tolerateGitHubError(
    () =>
      paginateAll<GitHubTeam>(
        client,
        (page) =>
          `/orgs/${encodeURIComponent(org)}/teams?per_page=100&page=${page}`,
      ),
    [],
  )
}

export function orgTeamsQuery(client: GitHubClient, org: string) {
  return queryOptions({
    queryKey: githubKeys.orgTeams(org),
    queryFn: () => listOrgTeams(client, org),
    enabled: Boolean(org),
    staleTime: 5 * 60 * 1000,
  })
}

// The teams the AUTHENTICATED viewer belongs to, across all orgs. Self-scoped
// (needs only read:org), so any member — including a student on no staff team —
// can call it, and it INCLUDES secret teams the viewer is a member of. Unlike
// listOrgTeams (which 404s -> [] for a non-owner who can't list an org's teams),
// this always returns the viewer's own memberships, so a caller can derive an
// org-level role signal without reading the config repo. Not tolerated to [] on
// error: the caller decides fail-closed vs. definitive-empty from the query
// state (a transient failure must hold, not read as "no teams").
export async function listMyTeams(client: GitHubClient): Promise<MyTeam[]> {
  return paginateAll<MyTeam>(
    client,
    (page) => `/user/teams?per_page=100&page=${page}`,
  )
}

export function myTeamsQuery(client: GitHubClient) {
  return queryOptions({
    queryKey: githubKeys.myTeams(),
    queryFn: () => listMyTeams(client),
    staleTime: 5 * 60 * 1000,
    retry: retryTransientGitHubError,
  })
}
