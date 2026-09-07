import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"
import {
  executeTeardown,
  teardownProgressOf,
  type TeardownPlan,
} from "@/domain/teardown"
import { githubKeys } from "@/github-core/queries"
import { orgClassroom50StatusKey } from "@/hooks/useOrgClassroom50Status"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Evict the setup-gating caches (service-token status + config-repo probe) for
// an org whose config repo is now gone. The wizard reads this data
// synchronously, so remove (not just invalidate). Cancel first: an in-flight
// save optimistically re-seeds "present" and would otherwise resurrect it.
function forgetSetupState(queryClient: QueryClient, org: string) {
  const keys = [githubKeys.serviceToken(org), orgClassroom50StatusKey(org)]
  for (const queryKey of keys) {
    void queryClient.cancelQueries({ queryKey })
    queryClient.removeQueries({ queryKey })
  }
}

// Execute a teardown (delete every repo + classroom team, marker deleted last).
// Refreshes the org list on every completed run; only forgets the setup-gating
// caches when the marker (config repo) was actually deleted — a retained marker
// (any partial run, including the rate-limit abort) leaves the org still set up,
// so evicting would flash the wizard back to step 1. Does NOT swallow the error —
// mutateAsync still REJECTS so the caller's ConfirmModal shows the failure
// inline; the clean-run home-redirect stays at the call site (see ./README.md).
export function useExecuteTeardown(plan: TeardownPlan | null) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  const refreshOrgs = () =>
    void queryClient.invalidateQueries({ queryKey: ["orgs"] })

  return useMutation({
    meta: { keepTabOpen: true },
    mutationFn: async () => {
      if (!plan) return
      return executeTeardown(client, plan)
    },
    onSuccess: (result) => {
      if (!plan) return
      refreshOrgs()
      if (result?.markerDeleted) forgetSetupState(queryClient, plan.org)
    },
    onError: (err) => {
      // Only refresh when the run actually deleted something: an abort that
      // changed nothing (marker re-check, network failure) would otherwise
      // discard the org cache and make the next dashboard visit refetch every
      // org summary for no reason. Rejection still propagates.
      if (teardownProgressOf(err)?.deleted.length) refreshOrgs()
    },
  })
}
