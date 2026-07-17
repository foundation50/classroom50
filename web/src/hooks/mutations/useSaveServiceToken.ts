import { useMutation, useQueryClient } from "@tanstack/react-query"
import { putRepoSecret, validateServiceToken } from "@/github-core/mutations"
import {
  githubKeys,
  SERVICE_TOKEN_SECRET_NAME,
  type ServiceTokenStatus,
} from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { CONFIG_REPO } from "@/util/configRepo"

// Validate a service PAT and store it as the config repo's
// CLASSROOM50_SERVICE_TOKEN secret. Hook seeds + invalidates the org list and
// this org's service-token status; the field-clear/saved-kind UI effects (and
// the useSafeSubmit composition) stay at the call site (see ./README.md).
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
      // Seed the status to "present" before the refetch so a UI deriving its
      // state from token presence (the setup wizard) advances even if the
      // invalidation refetch fails (offline / transient GitHub error) — the
      // save itself already succeeded. The seed survives such a failure because
      // getServiceTokenStatus now rethrows transient errors, so react-query
      // keeps this seeded data rather than overwriting it with a verdict. The
      // invalidate below reconciles the real created/updated timestamps once a
      // read lands.
      const now = new Date().toISOString()
      const seeded: ServiceTokenStatus = {
        status: "present",
        secretName: SERVICE_TOKEN_SECRET_NAME,
        createdAt: now,
        updatedAt: now,
        message: "",
      }
      queryClient.setQueryData(githubKeys.serviceToken(org ?? ""), seeded)
      queryClient.invalidateQueries({
        queryKey: githubKeys.serviceToken(org ?? ""),
      })
    },
  })
}
