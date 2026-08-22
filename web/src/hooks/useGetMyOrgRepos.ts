import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import { getOrgRepos, githubKeys } from "@/github-core/queries"

const useGetOrgRepos = (org: string, enabled = true) => {
  const client = useGitHubClient()

  return useQuery({
    queryKey: githubKeys.orgRepos(org),
    queryFn: () => getOrgRepos(client, org),
    // The org repo list (paginated across the whole org) drives the "Accepted"
    // signal. It's refreshed on explicit Refresh + normal staleness rather than
    // on every tab refocus, which used to re-paginate the entire org on focus.
    staleTime: 60 * 1000,
    // Callers that only need the list conditionally (e.g. the assignments table,
    // where no row needs repo presence) opt out so a whole-org pagination isn't
    // paid for nothing.
    enabled: enabled && Boolean(org),
  })
}

export default useGetOrgRepos
