// The onboarding page's state machine as a pure function (ordering + gates are
// unit-testable without React). OnboardingPage renders the returned state;
// useOnboardingState feeds it the query results.
//
// Precedence the page short-circuits through:
//   1. loading            — membership resolving, or (once present) the repo/team probes.
//   2. notInvited         — no membership record. A PENDING invite is NOT this
//                           (submitOnboarding accepts it before creating the repo).
//   3. pendingConfirmation — just submitted, or an onboarding repo exists.
//                           Before allSet, so a fresh submit shows pending even
//                           if team membership already activated.
//   4. allSet             — already on the classroom team.
//   5. form               — fall-through.
export type OnboardingState =
  "loading" | "notInvited" | "pendingConfirmation" | "allSet" | "form"

export type OnboardingStateInput = {
  loadingMembership: boolean
  // True once we have a membership and the dependent probes (onboarding repo,
  // team) are still loading. Kept separate so the caller can gate these probes
  // on membership having resolved first (they're disabled until then).
  loadingDependents: boolean
  // A membership record exists (active OR pending). Absent = never invited.
  hasMembership: boolean
  // The student just submitted onboarding in this session.
  justSubmitted: boolean
  // An onboarding repo for this classroom already exists (survives reload).
  hasOnboarded: boolean
  // The student is an active member of the (heuristic) classroom team.
  onClassroomTeam: boolean
}

export function deriveOnboardingState(
  input: OnboardingStateInput,
): OnboardingState {
  if (
    input.loadingMembership ||
    (input.hasMembership && input.loadingDependents)
  ) {
    return "loading"
  }
  if (!input.hasMembership) {
    return "notInvited"
  }
  if (input.justSubmitted || input.hasOnboarded) {
    return "pendingConfirmation"
  }
  if (input.onClassroomTeam) {
    return "allSet"
  }
  return "form"
}
