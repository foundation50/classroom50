import { useGithubAuth } from "@/auth/useGithubAuth"
import useGetOwnOrgMembership from "@/hooks/useGetOwnOrgMembership"
import { useAcceptAndVerifyMembership } from "@/hooks/onboarding/useAcceptAndVerifyMembership"
import { GitHubAPIError } from "@/hooks/github/errors"
import {
  classifyMembershipError,
  type MembershipErrorInfo,
} from "@/components/MembershipError"
import {
  deriveOnboardingState,
  type OnboardingState,
} from "@/hooks/onboarding/onboardingState"

// Whether a membership-read error should surface the error screen. A definitive
// 404 is NOT a read failure — it is GitHub's authoritative "no membership
// record" (the student was never invited), which must fall through to the calm
// notInvited screen. Every other error (403 / SSO-gated / transient 5xx) is a
// genuine read failure. Exported for unit testing the 404 boundary the live
// hook depends on (the pure deriveOnboardingState alone can't cover it).
export function isMembershipReadError(error: unknown): boolean {
  if (error instanceof GitHubAPIError && error.isNotFound) {
    return false
  }
  return Boolean(error)
}

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
    error: rawMembershipError,
    refetch: refetchMembership,
  } = useGetOwnOrgMembership(org)

  // A 404 from GET /user/memberships/orgs/{org} is not a read *failure* — it is
  // GitHub's authoritative "no membership record", i.e. the student was never
  // invited. Treat it as "no membership" so the state machine falls through to
  // the calm notInvited screen, and reserve the error screen for genuine read
  // failures (403 / SSO-gated / transient). The accept page keeps its own
  // 404 -> notAMember handling; this remapping is scoped to onboarding.
  const membershipReadError = isMembershipReadError(rawMembershipError)

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
    // flag that produced the error state. (A 404 never reaches here — it maps
    // to notInvited, not error.)
    const err = membershipReadError ? rawMembershipError : accept.error
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
