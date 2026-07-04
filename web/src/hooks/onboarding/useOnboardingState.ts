import { useGithubAuth } from "@/auth/useGithubAuth"
import useGetOwnOrgMembership from "@/hooks/useGetOwnOrgMembership"
import { useAcceptAndVerifyMembership } from "@/hooks/onboarding/useAcceptAndVerifyMembership"
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
  const { user } = useGithubAuth()

  const {
    data: orgMembership,
    isLoading: loadingMembership,
    error: membershipReadError,
    refetch: refetchMembership,
  } = useGetOwnOrgMembership(org)

  const hasMembership = Boolean(orgMembership)
  const alreadyActive = orgMembership?.state === "active"

  // Derive the accept trigger: a (pending) membership record exists, isn't
  // already active, and the read didn't error. The hook owns the fire-once
  // semantics and the never-invited/already-active outcomes.
  const shouldAccept = hasMembership && !alreadyActive && !membershipReadError
  const accept = useAcceptAndVerifyMembership({ org, enabled: shouldAccept })

  const active = alreadyActive || accept.isActive

  const state = deriveOnboardingState({
    loadingMembership,
    membershipReadError: Boolean(membershipReadError),
    hasMembership,
    acceptError: accept.isError,
    active,
  })

  let errorInfo: MembershipErrorInfo | null = null
  if (state === "error") {
    // Mirror deriveOnboardingState's precedence: a read error takes priority,
    // so classify it over any accept error to keep the cause aligned with the
    // flag that produced the error state.
    const err = membershipReadError ? membershipReadError : accept.error
    errorInfo = classifyMembershipError(err, {
      org,
      username: user?.login,
      membershipState: orgMembership?.state,
    })
  }

  return {
    state,
    errorInfo,
    // A read error can't be recovered by re-running the accept mutation (the
    // read failed before any pending record was seen), so refetch the
    // membership query in that case; otherwise re-run the accept/verify.
    retry: membershipReadError ? () => void refetchMembership() : accept.retry,
  }
}
