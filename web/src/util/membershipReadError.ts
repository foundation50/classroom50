import { GitHubAPIError } from "@/hooks/github/errors"

// Whether a membership-read error should surface the error screen. A definitive
// 404 is NOT a read failure — it is GitHub's authoritative "no membership
// record" (the student was never invited), which must fall through to the calm
// notInvited screen. Every other error (403 / SSO-gated / transient 5xx) is a
// genuine read failure. Extracted so the 404 boundary stays unit-testable
// without importing the whole page.
export function isMembershipReadError(error: unknown): boolean {
  if (error instanceof GitHubAPIError && error.isNotFound) {
    return false
  }
  return Boolean(error)
}
