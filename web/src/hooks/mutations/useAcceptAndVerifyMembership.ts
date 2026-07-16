import { useEffect } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"
import { acceptAndVerifyOrgMembership } from "@/domain/users"
import type { GitHubOrgMembership } from "@/github-core/types"

export type UseAcceptAndVerifyMembershipResult = {
  isActive: boolean
  isError: boolean
  isPending: boolean
  error: unknown
  retry: () => void
}

// Centralizes the accept-and-verify orchestration shared by the /onboard page
// and AcceptAssignmentPage: a mount-fired mutation (once, while `enabled`), a
// success path that seeds the shared membership cache, and one retry() source of
// truth that never overlaps an in-flight verify. Seed/retry rationale below.
export function useAcceptAndVerifyMembership(input: {
  org?: string
  // Fire the verify only when a (pending) membership record exists and isn't
  // already active. A never-invited student passes `false` and no mutation runs.
  enabled: boolean
}): UseAcceptAndVerifyMembershipResult {
  const { org, enabled } = input
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: () => acceptAndVerifyOrgMembership(client, org ?? ""),
    onSuccess: (membership: GitHubOrgMembership) => {
      // Seed the shared membership query (githubKeys.ownOrgMembership, read by
      // useGetOwnOrgMembership on the /onboard and accept pages) with the active
      // membership the verify read, so this page's redirect gate and the accept
      // page's read agree immediately instead of racing a lagged re-fetch.
      queryClient.setQueryData(githubKeys.ownOrgMembership(org), membership)
    },
  })

  // Fire once while enabled. The effect gates on `enabled` (a derived boolean),
  // so mutation.reset() flipping isIdle can't re-run it — retry() owns re-firing.
  useEffect(() => {
    if (enabled && mutation.isIdle) {
      mutation.mutate()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  return {
    isActive: mutation.isSuccess,
    isError: mutation.isError,
    isPending: mutation.isPending,
    error: mutation.error,
    retry: () => {
      // Single source of truth: reset() then mutate(). Do NOT also invalidate
      // the membership query — an unawaited invalidate refetch resolving to a
      // lagged value would race this mutate(); onSuccess seeds the verified
      // value instead. Skip while a verify is in flight so a retry tap can't
      // spawn a second overlapping PATCH+verify.
      if (!enabled || mutation.isPending) {
        return
      }
      mutation.reset()
      mutation.mutate()
    },
  }
}
