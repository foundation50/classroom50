import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  executeTeardown,
  TeardownRateLimitError,
  type TeardownPlan,
} from "@/domain/teardown"
import { githubKeys } from "@/github-core/queries"
import { orgClassroom50StatusKey } from "@/hooks/useOrgClassroom50Status"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Refresh the org list and DROP the setup-gating caches (service-token status +
// config-repo probe) for the torn-down org. Teardown deletes the config repo
// and its service-token secret, so remove (not just invalidate) those keys: the
// wizard derives its stage from `data` synchronously, and a lingering
// "present"/"ready" would jump a fresh re-add straight to "You're all set".
function forgetTeardownState(
  queryClient: ReturnType<typeof useQueryClient>,
  org: string,
) {
  void queryClient.invalidateQueries({ queryKey: ["orgs"] })
  queryClient.removeQueries({ queryKey: githubKeys.serviceToken(org) })
  queryClient.removeQueries({ queryKey: orgClassroom50StatusKey(org) })
}

// Execute a teardown (delete every repo + classroom team, marker deleted last).
// Hook refreshes org state on success AND on a rate-limit failure (which may
// have already deleted some repos). It does NOT swallow the error — mutateAsync
// still REJECTS so the caller's ConfirmModal shows the failure inline (the
// re-throw contract); the clean-run home-redirect stays at the call site (see
// ./README.md).
export function useExecuteTeardown(plan: TeardownPlan | null) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () => {
      if (!plan) return
      const result = await executeTeardown(client, plan)
      return result
    },
    onSuccess: () => {
      if (plan) forgetTeardownState(queryClient, plan.org)
    },
    onError: (err) => {
      // A scope/rate-limit failure may have already deleted some repos (and
      // possibly the config repo/secret), so refresh the org view and forget
      // the setup-gating caches. Rejection still propagates to the caller.
      if (err instanceof TeardownRateLimitError && plan) {
        forgetTeardownState(queryClient, plan.org)
      }
    },
  })
}
