import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { invalidateRepoCollaborators } from "@/github-core/queries"
import { removeRepoCollaborator } from "@/github-core/mutations"

export function useRemoveRepoCollaborator() {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (params: { org: string; repo: string; username: string }) =>
      removeRepoCollaborator({
        client,
        ...params,
      }),
    onSuccess: (_, variables) => {
      invalidateRepoCollaborators(queryClient, variables.org, variables.repo)
    },
  })
}

export default useRemoveRepoCollaborator
