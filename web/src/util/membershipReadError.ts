import { GitHubAPIError } from "@/github-core/errors"

// Whether a membership-read error should surface the error screen. A definitive
// 404 is NOT a read failure — it is GitHub's authoritative "no membership
// record" (never invited), which falls through to the calm notInvited screen.
// Every other error (403 / SSO-gated / transient 5xx) is a genuine failure.
// Extracted so the 404 boundary stays testable without the whole page.
export function isMembershipReadError(error: unknown): boolean {
  if (error instanceof GitHubAPIError && error.isNotFound) {
    return false
  }
  return Boolean(error)
}
