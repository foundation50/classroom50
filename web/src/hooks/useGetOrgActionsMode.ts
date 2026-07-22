import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"

import { githubKeys } from "@/github-core/queries"
import { getOrgActionsMode } from "@/github-core/mutations"

// Live autograding mode (active/paused), derived from the org Actions policy.
// No stored state — the toggle reflects whatever GitHub reports.
const useGetOrgActionsMode = (org: string) => {
  const client = useGitHubClient()
  return useQuery({
    queryKey: githubKeys.orgActionsMode(org),
    queryFn: () => getOrgActionsMode(client, org),
    enabled: Boolean(org),
    staleTime: 60 * 1000,
  })
}

export default useGetOrgActionsMode
