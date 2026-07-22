import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"

import { githubKeys, getOrgActionsBudget } from "@/github-core/queries"

// The org's Actions spending-budget classification (is a hard-stop cap set, and
// at what amount). Advisory: resolves to null when budgets aren't readable, so
// the caller renders nothing rather than an error.
const useGetOrgActionsBudget = (org: string) => {
  const client = useGitHubClient()
  return useQuery({
    queryKey: githubKeys.orgActionsBudget(org),
    queryFn: () => getOrgActionsBudget(client, org),
    enabled: Boolean(org),
    staleTime: 5 * 60 * 1000,
  })
}

export default useGetOrgActionsBudget
