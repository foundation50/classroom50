import { useQueries } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import type { GitHubOrgDetails } from "@/github-core/types"

export type NeedsSetupPlans = {
  // login -> plan name, or undefined when the plan isn't visible (non-owner) or
  // hasn't loaded yet.
  byLogin: Record<string, string | undefined>
  // logins whose plan query is still in flight. Every needs-setup org is
  // admin-owned (plan is visible), so a login is `pending` only while loading —
  // callers use this to avoid classifying a loading org as supported.
  pending: Set<string>
}

// Batch plan-name fetches for a set of org logins. Only the "needs setup" subset
// of the home view is passed in — every such org is admin-owned, so `plan` is
// visible — which keeps this fan-out off the general org list the home path
// avoids paying for. Keyed identically to useGetOrgPlanDetails so the setup page
// reuses the same cache.
const useNeedsSetupPlans = (logins: string[]): NeedsSetupPlans => {
  const client = useGitHubClient()

  const results = useQueries({
    queries: logins.map((login) => ({
      queryKey: ["github", "orgs", login],
      queryFn: () => client.request<GitHubOrgDetails>(`/orgs/${login}`),
      staleTime: 10 * 60 * 1000,
    })),
  })

  const byLogin: Record<string, string | undefined> = {}
  const pending = new Set<string>()
  logins.forEach((login, i) => {
    byLogin[login] = results[i]?.data?.plan?.name
    if (results[i]?.isPending) pending.add(login)
  })

  return { byLogin, pending }
}

export default useNeedsSetupPlans
