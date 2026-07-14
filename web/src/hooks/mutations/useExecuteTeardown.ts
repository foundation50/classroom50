import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  executeTeardown,
  TeardownRateLimitError,
  type TeardownPlan,
} from "@/domain/teardown"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Execute a teardown (delete every repo + classroom team, marker deleted last).
// Hook invalidates the org list on success AND on a rate-limit failure (which
// may have already deleted some repos). It does NOT swallow the error —
// mutateAsync still REJECTS so the caller's ConfirmModal shows the failure
// inline (the re-throw contract); the clean-run home-redirect stays at the call
// site (see ./README.md).
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
      void queryClient.invalidateQueries({ queryKey: ["orgs"] })
    },
    onError: (err) => {
      // A scope/rate-limit failure may have already deleted some repos, so
      // refresh the org view. Rejection still propagates to the caller.
      if (err instanceof TeardownRateLimitError) {
        void queryClient.invalidateQueries({ queryKey: ["orgs"] })
      }
    },
  })
}
