import { useMutation, useQueryClient } from "@tanstack/react-query"
import { putRepoSecret, validateServiceToken } from "@/github-core/mutations"
import { githubKeys } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { CONFIG_REPO } from "@/util/configRepo"

// Validate a service PAT and store it as the config repo's
// CLASSROOM50_SERVICE_TOKEN secret. Hook invalidates the org list + this org's
// service-token status; the field-clear/saved-kind/onSubmit UI effects (and the
// useSafeSubmit composition) stay at the call site (see ./README.md).
export function useSaveServiceToken(org: string | undefined) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (serviceToken: string) => {
      await validateServiceToken(serviceToken, org)
      return putRepoSecret(
        client,
        org,
        CONFIG_REPO,
        "CLASSROOM50_SERVICE_TOKEN",
        serviceToken,
      )
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orgs"] })
      queryClient.invalidateQueries({
        queryKey: githubKeys.serviceToken(org ?? ""),
      })
    },
  })
}
