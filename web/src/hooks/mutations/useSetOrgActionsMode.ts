import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"
import {
  setOrgActionsMode,
  type SetOrgActionsModeResult,
} from "@/github-core/mutations"

// Pause/resume autograding org-wide. Invalidates the derived actions-mode read,
// the org audit (its orgActions concern reads the same policy), and the usage +
// budget panels (a flip can change what's shown), so the whole section reflects
// the change. The invalidation lives in the hook's onSuccess so a mid-flight
// unmount can't drop it.
export function useSetOrgActionsMode(org: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation<SetOrgActionsModeResult, Error, "paused" | "active">({
    mutationFn: (mode) => setOrgActionsMode(client, org, mode),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.orgActionsMode(org),
      })
      void queryClient.invalidateQueries({
        queryKey: githubKeys.orgAuditPrefix(org),
      })
      void queryClient.invalidateQueries({
        queryKey: githubKeys.orgActionsUsage(org),
      })
      void queryClient.invalidateQueries({
        queryKey: githubKeys.orgActionsBudget(org),
      })
    },
  })
}

export default useSetOrgActionsMode
