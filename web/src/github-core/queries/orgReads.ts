import { queryOptions } from "@tanstack/react-query"

import type { GitHubClient } from "../client"
import type {
  GitHubFileListing,
  GitHubOrgMembership,
  GitHubUser,
} from "../types"
import { CONFIG_REPO } from "@/util/configRepo"
import { GitHubAPIError, tolerateGitHubError } from "../errors"
import { paginateAll } from "../paginate"
import type { OrgRunner, OrgRunnersResult } from "@/util/runners"
import { githubKeys } from "./keys"

export function orgMembershipQuery(client: GitHubClient, org: string) {
  return queryOptions({
    queryKey: githubKeys.orgMembership(org),
    queryFn: ({ signal }) =>
      client.request<GitHubOrgMembership>(
        `/user/memberships/orgs/${encodeURIComponent(org)}`,
        { method: "GET", signal },
      ),
    enabled: Boolean(org),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

// Self-hosted runners registered in the org (GitHub's admin:org endpoint), used
// only to advise whether a typed label exists. Tolerant: 403/404 resolve to an
// "unavailable" sentinel so the form degrades to "couldn't verify" instead of
// erroring. GitHub-hosted labels are recognized separately.
export function orgRunnersQuery(client: GitHubClient, org: string) {
  return queryOptions<OrgRunnersResult>({
    queryKey: githubKeys.orgRunners(org),
    queryFn: async ({ signal }) => {
      try {
        const runners: OrgRunner[] = []
        let page = 1

        while (true) {
          const data = await client.request<{
            total_count: number
            runners: OrgRunner[]
          }>(
            `/orgs/${encodeURIComponent(
              org,
            )}/actions/runners?per_page=100&page=${page}`,
            { method: "GET", signal },
          )

          const batch = data.runners ?? []
          runners.push(...batch)

          if (batch.length < 100) break
          page++
        }

        return { available: true, runners }
      } catch (error) {
        // Let cancellations propagate; don't cache them as a verdict.
        if (signal?.aborted) throw error
        // 403 (no admin:org) / 404 (no access) mean "can't read the list",
        // not "the runner doesn't exist".
        if (
          error instanceof GitHubAPIError &&
          (error.status === 403 || error.status === 404)
        ) {
          return { available: false, reason: "no-access" }
        }
        return { available: false, reason: "error" }
      }
    },
    enabled: Boolean(org),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

export function listOrgMembers(client: GitHubClient, org: string, page = 1) {
  return client.request<GitHubUser[]>(
    `/orgs/${org}/members?per_page=100&page=${page}`,
  )
}

// Every org member across all pages. `listOrgMembers` (used by the per-classroom
// roster, where the first 100 is effectively always enough) fetches a single
// page; the org Members page needs the full list, so it pages to completion.
export function listAllOrgMembers(client: GitHubClient, org: string) {
  return paginateAll<GitHubUser>(
    client,
    (page) => `/orgs/${org}/members?per_page=100&page=${page}`,
  )
}

// The active org-member list (all pages) as a shared query. Single source for
// the `orgMembersAll` cache both the classroom roster (needs-attention
// in-org/not-in-org split) and the org Members page read, so the two can't
// drift on cache key, fetcher, or freshness. Kept short (30s) and refetched on
// focus so classification reacts quickly to an invite accepted or a member
// removed in another tab/session; the affected sub-label is display-only
// (never enrollment, which is team-driven), so brief staleness is harmless.
export const ORG_MEMBERS_STALE_MS = 30 * 1000
export function orgMembersAllQuery(client: GitHubClient, org: string) {
  return queryOptions({
    queryKey: githubKeys.orgMembersAll(org),
    queryFn: () => listAllOrgMembers(client, org),
    enabled: Boolean(org),
    // Override the global refetchOnWindowFocus:false — see freshness note above.
    refetchOnWindowFocus: true,
    staleTime: ORG_MEMBERS_STALE_MS,
  })
}

// Org owners/admins across all pages (GET /orgs/{org}/members?role=admin). Used
// to badge the Members page: an admin is an "Owner", not a "Member". 403/404
// (can't read the filtered member list) -> [] so the page degrades to treating
// everyone as a plain member rather than erroring.
export async function listOrgAdmins(
  client: GitHubClient,
  org: string,
): Promise<GitHubUser[]> {
  return tolerateGitHubError(
    () =>
      paginateAll<GitHubUser>(
        client,
        (page) =>
          `/orgs/${encodeURIComponent(org)}/members?role=admin&per_page=100&page=${page}`,
      ),
    [],
    { predicate: (e) => e.isForbidden || e.isNotFound },
  )
}

export function orgAdminsQuery(client: GitHubClient, org: string) {
  return queryOptions({
    queryKey: githubKeys.orgAdmins(org),
    queryFn: () => listOrgAdmins(client, org),
    enabled: Boolean(org),
    staleTime: 5 * 60 * 1000,
  })
}

// Server-side equivalent of useGetClasses: classroom dirs in the org's
// classroom50 repo (root contents, dirs minus .github), for non-hook callers.
export async function listClassroomDirs(
  client: GitHubClient,
  org: string,
  ref?: string,
): Promise<GitHubFileListing[]> {
  const raw = await client.requestRaw(
    `/repos/${encodeURIComponent(org)}/${CONFIG_REPO}/contents/${
      ref ? `?ref=${encodeURIComponent(ref)}` : ""
    }`,
    { method: "GET" },
  )
  const listing = JSON.parse(raw) as GitHubFileListing[]
  return listing.filter(
    (entry) => entry.type === "dir" && entry.name !== ".github",
  )
}

export async function listAuthedOrgMemberships(client: GitHubClient) {
  return client.request<GitHubOrgMembership[]>(
    "/user/memberships/orgs?per_page=100",
  )
}

export async function getAuthedOrgMembership(
  client: GitHubClient,
  org: string,
) {
  return client.request<GitHubOrgMembership>(`/user/memberships/orgs/${org}`)
}
