import { createFileRoute } from "@tanstack/react-router"
import OnboardingPage from "@/pages/OnboardingPage"
import { isSafeReturnTo } from "@/auth/returnTo"

// `returnTo`: where to send the student after they become an active member (the
// accept page sets it). Kept only when it passes isSafeReturnTo (open-redirect
// guard). The self-report `email`/`t` inputs were removed — onboarding is now
// a pure accept-invite-then-verify flow with no form.

export const Route = createFileRoute("/_authed/$org/$classroom/onboard/")({
  validateSearch: (search: Record<string, unknown>): { returnTo?: string } => ({
    returnTo: isSafeReturnTo(search.returnTo) ? search.returnTo : undefined,
  }),
  component: OnboardingPage,
})
