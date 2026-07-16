import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ConcernId } from "@/orgPolicy/audit"
import { repairConcern, type RepairResult } from "@/orgPolicy/repair"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Repair a single API-repairable org-policy concern. The hook owns the
// always-run data-consistency effects: the audit-prefix invalidation AND the
// caller's `onRepaired` (which records the persistent "didn't stick" outcome to
// the per-org store). Both run in the hook's onSuccess so a mid-repair unmount
// (e.g. an org switch remounting the pane) can't drop the durable write.
// Pure component-state (enterprise-pin / unresolved-concern / transient-notice
// setState) stays at the call site's per-call onSuccess (skipped on unmount).
export function useRepairOrgPolicyConcern(
  org: string,
  plan: string | undefined,
  // Data-consistency follow-up: persist the classified outcome. Runs in the
  // hook (unmount-safe), NOT the call site.
  onRepaired: (result: RepairResult, id: ConcernId) => void,
) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: ConcernId) => repairConcern(client, org, id, plan),
    onSuccess: (result, id) => {
      onRepaired(result, id)
      void queryClient.invalidateQueries({
        queryKey: githubKeys.orgAuditPrefix(org),
      })
    },
  })
}

export default useRepairOrgPolicyConcern
