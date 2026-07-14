import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useQuery } from "@tanstack/react-query"

import { githubKeys } from "@/github-core/queries"
import { buildOrgAuditReport } from "@/orgPolicy/audit"

// Read-only org policy audit. Plan-aware (enterprise unlocks the 4
// enterprise-only fields), so it waits for the plan to be known — otherwise an
// enterprise org would be audited as non-enterprise.
const useGetOrgAudit = (org: string, plan: string | undefined) => {
  const client = useGitHubClient()
  return useQuery({
    queryKey: githubKeys.orgAudit(org, plan),
    queryFn: () => buildOrgAuditReport(client, org, plan),
    enabled: Boolean(org) && Boolean(plan),
    staleTime: 5 * 60 * 1000,
  })
}

export default useGetOrgAudit
