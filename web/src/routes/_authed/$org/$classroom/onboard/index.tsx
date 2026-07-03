import { createFileRoute } from "@tanstack/react-router"
import OnboardingPage from "@/pages/OnboardingPage"
import { isValidInviteToken } from "@/util/onboarding"
import { isSafeReturnTo } from "@/auth/returnTo"

// `email`: untrusted prefill only; session authorizes.
//
// `t`: optional secure-link invite token. Declared here so a future strict-search
// change can't silently drop it; a garbage value degrades to the classroom-wide
// flow (github_id, else email).
//
// `returnTo`: where to send the student after they become an active member (the
// accept page sets it). Kept only when it passes isSafeReturnTo (open-redirect
// guard).

export const Route = createFileRoute("/_authed/$org/$classroom/onboard/")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { email?: string; t?: string; returnTo?: string } => ({
    email: typeof search.email === "string" ? search.email : undefined,
    t:
      typeof search.t === "string" && isValidInviteToken(search.t)
        ? search.t
        : undefined,
    returnTo: isSafeReturnTo(search.returnTo) ? search.returnTo : undefined,
  }),
  component: OnboardingPage,
})
