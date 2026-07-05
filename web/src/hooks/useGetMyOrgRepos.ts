import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import { getOrgRepos } from "./github/queries"

const useGetOrgRepos = (org: string) => {
  const client = useGitHubClient()

  return useQuery({
    queryKey: ["orgs", org, "repos"],
    queryFn: () => getOrgRepos(client, org),
    // Drives the "Accepted" count from repo existence; keep it fresh so a tab
    // refocus reflects newly accepted assignments instead of a 10-min cache.
    staleTime: 20 * 1000,
  })
}

export default useGetOrgRepos
