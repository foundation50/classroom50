import { useEffect } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { acceptAndVerifyOrgMembership } from "@/api/mutations/users"
import type { GitHubOrgMembership } from "@/hooks/github/types"

// The shared membership query key, read by useGetOwnOrgMembership on both the
// onboarding and accept pages. Kept here so success can seed it directly.
const membershipQueryKey = (org?: string) => [
  "github",
  "memberships",
  "orgs",
  org,
]

export type UseAcceptAndVerifyMembershipResult = {
  isActive: boolean
  isError: boolean
  isPending: boolean
  error: unknown
  retry: () => void
}

// Centralizes the accept-and-verify orchestration shared by OnboardingPage and
// AcceptAssignmentPage: a mount-fired mutation (once, while `enabled`), a
// success path that seeds the shared membership cache, and a single retry()
// source of truth that never overlaps an in-flight verify. The seed and retry
// rationale live at their call sites below.
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
      // Seed the shared membership query with the active membership the verify
      // authoritatively read, so this page's redirect gate and the accept
      // page's read agree immediately instead of racing a lagged re-fetch.
      queryClient.setQueryData(membershipQueryKey(org), membership)
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
      // the membership query here — an unawaited invalidate refetch resolving
      // to a lagged value would race this mutate(). On success, onSuccess seeds
      // the cache with the verified value. Skip while a verify is in flight so
      // a retry tap can't spawn a second overlapping PATCH+verify.
      if (!enabled || mutation.isPending) {
        return
      }
      mutation.reset()
      mutation.mutate()
    },
  }
}
