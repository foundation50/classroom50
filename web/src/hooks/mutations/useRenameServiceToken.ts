import { useMutation, useQueryClient } from "@tanstack/react-query"
import { putRepoVariable } from "@/github-core/mutations"
import { githubKeys, SERVICE_TOKEN_NAME_VAR } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { CONFIG_REPO } from "@/util/configRepo"

// Rename the service token's stored display LABEL — writes only the
// CLASSROOM50_SERVICE_TOKEN_NAME repo variable, not the secret. This is how
// Classroom 50 refers to the token in the UI; it does not (and cannot) rename
// the actual fine-grained PAT on GitHub, whose name is not API-writable.
// Invalidates this org's service-token status so the new label reads back.
export function useRenameServiceToken(org: string | undefined) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (name: string) => {
      const trimmed = name.trim()
      if (!trimmed) throw new Error("Enter a name before saving.")
      await putRepoVariable(
        client,
        org,
        CONFIG_REPO,
        SERVICE_TOKEN_NAME_VAR,
        trimmed,
      )
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: githubKeys.serviceToken(org ?? ""),
      })
      queryClient.invalidateQueries({ queryKey: ["orgs"] })
    },
  })
}
