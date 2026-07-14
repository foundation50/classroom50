import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import type { GitHubOrgDetails } from "@/github-core/types"

const useGetOrgPlanDetails = (org?: string) => {
  const client = useGitHubClient()

  return useQuery({
    queryKey: ["github", "orgs", org],
    queryFn: () => client.request<GitHubOrgDetails>(`/orgs/${org}`),
    enabled: !!org,
    staleTime: 10 * 60 * 1000,
  })
}

export default useGetOrgPlanDetails
