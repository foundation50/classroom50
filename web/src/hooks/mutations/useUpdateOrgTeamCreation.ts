import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"
import { updateOrgTeamCreation } from "@/github-core/mutations"
import type { GitHubOrgDetails } from "@/github-core/types"

// Flip the org's "Allow members to create teams" privilege (owner-only). The
// PATCH response is the canonical updated org: seed the shared orgDetails
// cache so the toggle and the assignment-form gate flip immediately, then
// invalidate it plus the audit prefix — the org-policy audit classifies this
// field, so a stale verdict would contradict the toggle. Cache effects live in
// the hook's onSuccess so a mid-flight unmount can't drop them.
export function useUpdateOrgTeamCreation(org: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation<GitHubOrgDetails, Error, boolean>({
    mutationFn: (allow) => updateOrgTeamCreation(client, org, allow),
    onSuccess: (updated) => {
      queryClient.setQueryData(githubKeys.orgDetails(org), updated)
      void queryClient.invalidateQueries({
        queryKey: githubKeys.orgDetails(org),
      })
      void queryClient.invalidateQueries({
        queryKey: githubKeys.orgAuditPrefix(org),
      })
    },
  })
}

export default useUpdateOrgTeamCreation
