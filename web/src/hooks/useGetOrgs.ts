import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"
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

const orgMembershipsQuery = (client: GitHubClient) => ({
  queryKey: orgMembershipsQueryKey,
  queryFn: () => listAuthedOrgMemberships(client),
  staleTime: 10 * 60 * 1000,
})

const useOrgMemberships = (client: GitHubClient) =>
  useQuery(orgMembershipsQuery(client))

const fetchActiveSummaries = async (
  queryClient: QueryClient,
  client: GitHubClient,
) => {
  const list = await queryClient.fetchQuery(orgMembershipsQuery(client))
  return Promise.all(
    list
      .filter((membership) => membership.state === "active")
      .map((membership) => getClassroom50OrgSummary(client, membership)),
  )
}

const useGetOrgs = () => {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const memberships = useOrgMemberships(client)

  const summaries = useQuery({
    queryKey: ["orgs", "active-summaries"],
    // Pull the membership list through the cache instead of deriving it from a
    // render: keying on the list meant one invalidation refetched the old key
    // against the pre-refresh list, running the whole fan-out twice and
    // dropping a just-granted org until a second refresh.
    queryFn: () => fetchActiveSummaries(queryClient, client),
    staleTime: 10 * 60 * 1000,
  })

  return {
    ...summaries,
    // The summaries fetch subsumes the memberships one, so fold the latter's
    // states in to keep the page's spinner covering the whole chain.
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
