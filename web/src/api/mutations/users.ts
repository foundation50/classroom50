import type { GitHubClient } from "@/hooks/github/client"
import { getPendingOrgInvite } from "@/hooks/github/mutations"
import type { GitHubOrgMembership } from "@/hooks/github/types"

// Accept a pending org invitation for the authenticated user. Returns whether
// the PATCH succeeded so callers can distinguish "now active" from a transient
// failure (a swallowed failure previously stranded the onboarding round-trip on
// a redirect that never fired). Still best-effort: never throws.
export async function acceptPendingOrgInvite(
  client: GitHubClient,
  org: string,
): Promise<{ ok: boolean }> {
  try {
    await acceptPendingOrgInviteOrThrow(client, org)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

// PATCH /user/memberships/orgs/{org} -> {state:"active"}. The throwing variant:
// surfaces the raw GitHubAPIError (status, url, body, X-GitHub-SSO) so callers
// can distinguish an SSO-gated 403 from a genuine failure. Used by the shared
// verified-accept path below; acceptPendingOrgInvite wraps it best-effort.
export async function acceptPendingOrgInviteOrThrow(
  client: GitHubClient,
  org: string,
): Promise<void> {
  await client.request(`/user/memberships/orgs/${org}`, {
    method: "PATCH",
    body: {
      state: "active",
    },
  })
}

// The single verified-accept path consumed by every call site (OnboardingPage,
// AcceptAssignmentPage, the accept mutation): accept the pending org invite,
// re-read GET /user/memberships/orgs/{org}, and assert state === "active".
// Throws the raw GitHubAPIError on any read/PATCH failure (a 403 + X-GitHub-SSO
// SSO gate, a 404 not-a-member, or a transient blip) so the caller can render a
// cause-specific screen from the shared MembershipError component. Returns the
// active membership on success.
export async function acceptAndVerifyOrgMembership(
  client: GitHubClient,
  org: string,
): Promise<GitHubOrgMembership> {
  // Accepting a pending invite is idempotent-ish: an already-active member's
  // PATCH still succeeds, so we don't pre-read state here — one PATCH then one
  // authoritative read keeps the composition thin.
  await acceptPendingOrgInviteOrThrow(client, org)
  const membership = await getPendingOrgInvite(client, org)
  if (membership.state !== "active") {
    throw new NotActiveMemberError(org, membership.state)
  }
  return membership
}

// Thrown by acceptAndVerifyOrgMembership when the invite was accepted but the
// re-read membership is still not "active" (e.g. GitHub lag). Distinct from a
// GitHubAPIError so the UI can offer a retry rather than a not-a-member screen.
export class NotActiveMemberError extends Error {
  org: string
  state: string
  constructor(org: string, state: string) {
    super(`Membership in ${org} is "${state}", not "active"`)
    this.name = "NotActiveMemberError"
    this.org = org
    this.state = state
  }
}
