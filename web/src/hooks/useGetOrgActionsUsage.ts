import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"

import { githubKeys, getOrgActionsUsage } from "@/github-core/queries"

// Current-month GitHub Actions usage (minutes + $). Advisory: resolves to null
// when billing isn't readable, so the caller renders nothing rather than an
// error. Cached for 5 min — billing figures don't move minute-to-minute.
const useGetOrgActionsUsage = (org: string) => {
  const client = useGitHubClient()
  return useQuery({
    queryKey: githubKeys.orgActionsUsage(org),
    queryFn: () => getOrgActionsUsage(client, org),
    enabled: Boolean(org),
    staleTime: 5 * 60 * 1000,
  })
}

export default useGetOrgActionsUsage
