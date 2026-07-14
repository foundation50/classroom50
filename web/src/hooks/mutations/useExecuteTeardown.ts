import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  executeTeardown,
  TeardownRateLimitError,
  type TeardownPlan,
} from "@/api/mutations/teardown"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Execute a teardown (delete every repo + classroom team, marker deleted last).
// Per the TanStack split (see hooks/mutations), the hook owns only the org-list
// invalidation that must always run: on success unconditionally, and on a
// rate-limit failure (which may have already deleted some repos). It does NOT
// swallow the error — mutateAsync still REJECTS so the caller's ConfirmModal can
// show the failure inline (the re-throw contract); the conditional home-redirect
// on a clean run also stays at the call site.
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
