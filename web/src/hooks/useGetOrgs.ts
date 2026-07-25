import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import type { GitHubClient } from "@/github-core/client"
import type { GitHubOrgMembership } from "@/github-core/types"
import {
  getClassroom50OrgSummary,
  listAuthedOrgMemberships,
} from "@/github-core/queries"

// One fetch of /user/memberships/orgs backs both the active-org list and the
// pending-invite list, so the two hooks share a cache entry instead of racing
// duplicate calls.
export const orgMembershipsQueryKey = ["orgs", "memberships"]

const useOrgMemberships = (client: GitHubClient) =>
  useQuery({
    queryKey: orgMembershipsQueryKey,
    queryFn: () => listAuthedOrgMemberships(client),
    staleTime: 10 * 60 * 1000,
  })

const useGetOrgs = () => {
  const client = useGitHubClient()
  const memberships = useOrgMemberships(client)

  const active = (memberships.data ?? []).filter(
    (membership) => membership.state === "active",
  )

  const summaries = useQuery({
    // Keyed on the membership list it derives from: an unkeyed queryFn would run
    // against the stale list, dropping a just-granted org until a second refresh.
    queryKey: [
      "orgs",
      "active-summaries",
      active.map((m) => m.organization.login).join(","),
    ],
    enabled: memberships.data !== undefined,
    queryFn: () =>
      Promise.all(
        active.map((membership) =>
          getClassroom50OrgSummary(client, membership),
        ),
      ),
    // The key changes with the membership list; without kept-previous data
    // `data` blanks for a render and flashes the page's full-screen spinner.
    placeholderData: (previous) => previous,
    staleTime: 10 * 60 * 1000,
  })

  return {
    ...summaries,
    // The summaries query is disabled until memberships resolve; a disabled
    // query reports isLoading=false, so fold in the memberships fetch to keep
    // the page's spinner covering the whole chain (no empty-state flash).
    isLoading: memberships.isLoading || summaries.isLoading,
    isFetching: memberships.isFetching || summaries.isFetching,
  }
}

// Orgs the viewer has been invited to but hasn't joined yet. Pending members
// can't read the org's classroom50 config repo, so we surface the raw
// membership (org avatar/name/description + invited role) without the
// classroom50 status probe that getClassroom50OrgSummary does for active orgs.
export const usePendingOrgInvites = () => {
  const client = useGitHubClient()
  const { data, ...rest } = useOrgMemberships(client)
  const pending: GitHubOrgMembership[] = (data ?? []).filter(
    (membership) => membership.state === "pending",
  )
  return { ...rest, data: pending }
}

export default useGetOrgs
