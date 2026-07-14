import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { githubKeys } from "@/github-core/queries"
import { addRepoCollaborator } from "@/github-core/mutations"

export function useAddRepoCollaborator() {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (params: {
      org: string
      repo: string
      username: string
      permission?: "pull" | "triage" | "push" | "maintain" | "admin"
    }) =>
      addRepoCollaborator({
        client,
        ...params,
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: githubKeys.collaborators(variables.org, variables.repo),
      })
    },
  })
}

export default useAddRepoCollaborator
