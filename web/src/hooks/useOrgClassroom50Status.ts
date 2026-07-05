import { useQuery } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { GitHubAPIError, retryTransientGitHubError } from "./github/errors"

export type OrgClassroom50Status = "ready" | "missing" | "unknown"

// Single-org probe for the `classroom50` config repo, to gate /$org/* routes.
// Distinct from getClassroom50OrgSummary, which fans out across every org on the
// landing page. 404 = missing (unset or private to me); any other error stays
// "unknown" (undefined data) so a transient blip never reports missing.
export function useOrgClassroom50Status(org: string | undefined) {
  const client = useGitHubClient()

  return useQuery<OrgClassroom50Status>({
    queryKey: ["github", "repos", org, "classroom50", "exists"],
    queryFn: async () => {
      try {
        await client.request(`/repos/${org}/classroom50`)
        return "ready"
      } catch (error) {
        if (error instanceof GitHubAPIError && error.status === 404) {
          return "missing"
        }
        throw error
      }
    },
    staleTime: 10 * 60 * 1000,
    retry: retryTransientGitHubError,
    enabled: Boolean(org),
  })
}
