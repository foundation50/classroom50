import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import { getOrgRepos, githubKeys } from "@/github-core/queries"

const useGetOrgRepos = (org: string) => {
  const client = useGitHubClient()

  return useQuery({
    queryKey: githubKeys.orgRepos(org),
    queryFn: () => getOrgRepos(client, org),
    // Drives the "Accepted" count; refetch on tab refocus (overriding the global
    // refetchOnWindowFocus:false) so it reflects newly accepted assignments.
    refetchOnWindowFocus: true,
    staleTime: 20 * 1000,
  })
}

export default useGetOrgRepos
