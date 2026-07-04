// The /onboard page's state precedence as a pure function, so the ordering +
// gates are unit-testable without a DOM. OnboardingPage feeds it the membership
// read + auto-accept mutation status and renders the returned state.
//
// Precedence the page short-circuits through:
//   1. error      — the membership read failed, or accept/verify failed. A read
//                   error takes priority so a stale "active" can't mask it.
//   2. active     — verified active membership; "you're all set" / redirect.
//   3. loading    — the initial membership read is resolving, OR a membership
//                   record exists and the accept/verify mutation is (about to
//                   be) in flight. A pending invite is NOT notInvited.
//   4. notInvited — no membership record at all (never invited).
export type OnboardingState = "loading" | "notInvited" | "active" | "error"

export type OnboardingStateInput = {
  // The initial GET /user/memberships/orgs/{org} read is still resolving.
  loadingMembership: boolean
  // That read errored (e.g. SSO 403, unexpected). A definitive 404 is NOT this
  // (see isMembershipReadError) — it falls through to notInvited.
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
  if (input.loadingMembership || input.hasMembership) {
    // A pending record with no verified-active yet means the accept/verify is
    // (about to be) in flight — keep the student on the loading screen.
    return "loading"
  }
  return "notInvited"
}
