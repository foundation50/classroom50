import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"
import { getOrgRepos, githubKeys } from "@/github-core/queries"

// Freshness for the org repo list. It drives the "Accepted" signal, so it is
// refreshed on explicit Refresh, after accept/collect/rename (invalidations),
// and on normal staleness rather than on every tab refocus or return to the
// page: on a large org the walk is dozens of requests, and a student who
// accepts between visits is picked up by the next Refresh or collect.
export const ORG_REPOS_STALE_MS = 5 * 60 * 1000

const useGetOrgRepos = (org: string, enabled = true) => {
  const client = useGitHubClient()

  return useQuery({
    queryKey: githubKeys.orgRepos(org),
    queryFn: ({ signal }) => getOrgRepos(client, org, { signal }),
    staleTime: ORG_REPOS_STALE_MS,
    // Pages retry individually inside the walk; a query-level retry would
    // re-walk the whole org after one late page.
    retry: false,
    // Callers that only need the list conditionally opt out via `enabled` so a
    // whole-org pagination isn't paid for nothing (e.g. the sidebar gating a
    // staff-only read on role).
    enabled: enabled && Boolean(org),
  })
}

export default useGetOrgRepos
