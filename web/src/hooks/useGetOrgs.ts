import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import type { GitHubClient } from "@/hooks/github/client"
import type { GitHubOrgMembership } from "@/hooks/github/types"
import {
  getClassroom50OrgSummary,
  listAuthedOrgMemberships,
} from "./github/queries"

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

  const summaries = useQuery({
    queryKey: ["orgs", "active-summaries"],
    enabled: memberships.data !== undefined,
    queryFn: () => {
      const active = (memberships.data ?? []).filter(
        (membership) => membership.state === "active",
      )
      return Promise.all(
        active.map((membership) =>
          getClassroom50OrgSummary(client, membership),
        ),
      )
    },
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
