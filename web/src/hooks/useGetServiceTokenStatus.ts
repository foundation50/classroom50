import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import { getServiceTokenStatus, githubKeys } from "@/github-core/queries"

const useGetServiceTokenStatus = (org: string) => {
  const client = useGitHubClient()
  return useQuery({
    queryKey: githubKeys.serviceToken(org),
    queryFn: () => getServiceTokenStatus(client, org),
    enabled: Boolean(org),
    staleTime: 10 * 60 * 1000,
  })
}

export default useGetServiceTokenStatus
