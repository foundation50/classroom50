import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import type { GitHubOrgDetails } from "@/github-core/types"

// The org's human-friendly display name (e.g. "Classroom 50 Summer Dev" for the
// `classroom50-summer-dev` login), or undefined when unavailable/still loading —
// callers fall back to the login. Fetched lazily per shown org so the home list
// doesn't fan out GET /orgs/{login} across every membership up front; keyed
// identically to useGetOrgPlanDetails so it shares that cache.
const useOrgDisplayName = (login?: string): string | undefined => {
  const client = useGitHubClient()

  const { data } = useQuery({
    queryKey: ["github", "orgs", login],
    queryFn: () => client.request<GitHubOrgDetails>(`/orgs/${login}`),
    enabled: !!login,
    staleTime: 10 * 60 * 1000,
  })

  return data?.name ?? undefined
}

export default useOrgDisplayName
