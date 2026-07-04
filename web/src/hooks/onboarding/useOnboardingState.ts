import { useEffect } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useGithubAuth } from "@/auth/useGithubAuth"
import useGetOwnOrgMembership from "@/hooks/useGetOwnOrgMembership"
import { acceptAndVerifyOrgMembership } from "@/api/mutations/users"
import {
  classifyMembershipError,
  type MembershipErrorInfo,
} from "@/components/MembershipError"
import {
  deriveOnboardingState,
  type OnboardingState,
} from "@/hooks/onboarding/onboardingState"

export type UseOnboardingStateResult = {
  state: OnboardingState
  // Populated when `state === "error"`; drives the MembershipError component.
  errorInfo: MembershipErrorInfo | null
  // Re-runs the auto-accept + verify mutation (backs the retry affordances).
  retry: () => void
}

// Reads the student's own org membership and, once a membership record exists,
// runs the shared accept-and-verify mutation on mount (no self-report form).
// Folds the membership read + mutation status through the pure
// deriveOnboardingState and hands back the cause-specific error info.
export function useOnboardingState(input: {
  org?: string
  classroom?: string
}): UseOnboardingStateResult {
  const { org } = input
  const client = useGitHubClient()
  const { user } = useGithubAuth()
  const queryClient = useQueryClient()

  const {
    data: orgMembership,
    isLoading: loadingMembership,
    error: membershipReadError,
  } = useGetOwnOrgMembership(org)

  const hasMembership = Boolean(orgMembership)
  const alreadyActive = orgMembership?.state === "active"

  const acceptMutation = useMutation({
    mutationFn: () => acceptAndVerifyOrgMembership(client, org ?? ""),
    onSuccess: () => {
      // The shared membership query (also read by the accept page) is now
      // stale — invalidate so both this page's redirect gate and the accept
      // page re-read "active" and can't diverge into a bounce loop.
      void queryClient.invalidateQueries({
        queryKey: ["github", "memberships", "orgs", org],
      })
    },
  })

  // Fire the accept-and-verify once, only when a (pending) membership exists
  // and isn't already active. A never-invited student (no record) shows
  // notInvited without a mutation; an already-active one is active immediately.
  const shouldAccept = hasMembership && !alreadyActive && !membershipReadError
  useEffect(() => {
    if (shouldAccept && acceptMutation.isIdle) {
      acceptMutation.mutate()
    }
    // acceptMutation identity is stable per render for our purposes; gate on
    // the derived trigger only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAccept])

  const active = alreadyActive || acceptMutation.isSuccess

  const state = deriveOnboardingState({
    loadingMembership,
    membershipReadError: Boolean(membershipReadError),
    hasMembership,
    acceptError: acceptMutation.isError,
    active,
  })

  let errorInfo: MembershipErrorInfo | null = null
  if (state === "error") {
    const err = membershipReadError ?? acceptMutation.error
    errorInfo = classifyMembershipError(err, {
      org,
      username: user?.login,
      membershipState: orgMembership?.state,
    })
  }

  return {
    state,
    errorInfo,
    retry: () => {
      // Re-fire the accept/verify directly — the mount effect gates on
      // `shouldAccept`, which doesn't change on retry, so it won't re-run on
      // its own. Invalidate the shared membership query too so a genuinely
      // flipped membership is observed.
      void queryClient.invalidateQueries({
        queryKey: ["github", "memberships", "orgs", org],
      })
      acceptMutation.reset()
      if (hasMembership && !alreadyActive) {
        acceptMutation.mutate()
      }
    },
  }
}
