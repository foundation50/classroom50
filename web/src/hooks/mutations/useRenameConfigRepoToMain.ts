import { useMutation, useQueryClient } from "@tanstack/react-query"
import { renameConfigRepoToMain } from "@/github-core/mutations"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Rename the config repo's default branch to `main`. Hook owns the audit-prefix
// invalidation so the recommendation clears; the confirm modal + any UI stay at
// the call site (see ./README.md).
export function useRenameConfigRepoToMain(org: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => renameConfigRepoToMain(client, org),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.orgAuditPrefix(org),
      })
    },
  })
}

export default useRenameConfigRepoToMain
