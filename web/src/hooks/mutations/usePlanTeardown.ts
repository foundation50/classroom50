import { useMutation } from "@tanstack/react-query"
import { planTeardown } from "@/domain/teardown"
import { useGitHubClient } from "@/context/github/GitHubProvider"

// Plan a teardown: enumerate the org's repos + classroom teams for the confirm
// modal. A pure read that only populates UI state (no cache to invalidate), so
// the hook wraps the call and the caller owns every callback via `mutate`.
export function usePlanTeardown(org: string) {
  const client = useGitHubClient()

  return useMutation({
    mutationFn: () => planTeardown(client, org),
  })
}
