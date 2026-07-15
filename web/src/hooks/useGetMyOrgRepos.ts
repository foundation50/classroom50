import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import { getOrgRepos, githubKeys } from "@/github-core/queries"

const useGetOrgRepos = (org: string) => {
  const client = useGitHubClient()

  return useQuery({
    queryKey: githubKeys.orgRepos(org),
    queryFn: () => getOrgRepos(client, org),
    // Drives the "Accepted" count from repo existence; keep it fresh so a tab
    // refocus reflects newly accepted assignments instead of a 10-min cache.
    staleTime: 20 * 1000,
  })
}

export default useGetOrgRepos
