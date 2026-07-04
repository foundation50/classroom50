// The onboarding page's state machine as a pure function (ordering + gates are
// unit-testable without React). OnboardingPage renders the returned state;
// useOnboardingState feeds it the membership read + auto-accept mutation status.
//
// The page no longer collects a self-report form. On mount it reads the
// student's own org membership, then (if a membership record exists) runs the
// shared accept-and-verify mutation. Precedence the page short-circuits through:
//   1. loading    — the initial membership read is resolving, OR a membership
//                   exists and the accept/verify mutation is in flight.
//   2. notInvited — no membership record at all (never invited). A pending
//                   invite is NOT this: the mutation accepts it.
//   3. error      — the membership read failed, or accept/verify failed. The
//                   page renders the cause-specific MembershipError component.
//   4. active     — verified active membership; "you're all set" / redirect.
export type OnboardingState = "loading" | "notInvited" | "active" | "error"

export type OnboardingStateInput = {
  // The initial GET /user/memberships/orgs/{org} read is still resolving.
  loadingMembership: boolean
  // That read errored (e.g. SSO 403, unexpected). Surfaces the error screen
  // without ever attempting the accept mutation.
  membershipReadError: boolean
  // A membership record exists (active OR pending). Absent = never invited.
  hasMembership: boolean
  // The accept-and-verify mutation failed (SSO / not-a-member / transient).
  acceptError: boolean
  // Verified active membership (mutation succeeded, or the initial read was
  // already "active").
  active: boolean
}

export function deriveOnboardingState(
  input: OnboardingStateInput,
): OnboardingState {
  if (input.membershipReadError || input.acceptError) {
    return "error"
  }
  if (input.active) {
    return "active"
  }
  if (input.loadingMembership) {
    return "loading"
  }
  if (!input.hasMembership) {
    return "notInvited"
  }
  // Membership record exists but is not yet verified active and there's no
  // error: the accept/verify mutation is in flight or about to fire — keep the
  // student on the loading screen until it resolves.
  return "loading"
}
