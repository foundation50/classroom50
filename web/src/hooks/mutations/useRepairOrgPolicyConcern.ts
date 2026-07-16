import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ConcernId } from "@/orgPolicy/audit"
import { repairConcern } from "@/orgPolicy/repair"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Repair a single API-repairable org-policy concern. Thin: the hook owns ONLY
// the audit-prefix invalidation. classifyRepairOutcome and the enterprise-pin /
// unresolved-concern / transient-notice component state stay at the call site
// via a per-call onSuccess (see ./README.md).
export function useRepairOrgPolicyConcern(org: string, plan?: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: ConcernId) => repairConcern(client, org, id, plan),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.orgAuditPrefix(org),
      })
    },
  })
}

export default useRepairOrgPolicyConcern
