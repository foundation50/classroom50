import type { GitHubClient } from "@/github-core/client"
import { cancelOrgInvitation } from "@/github-core/mutations"
import { getOrgFailedInvitations } from "@/github-core/queries"
import { tolerateGitHubError } from "@/github-core/errors"
import type { ClassroomRole } from "@/util/teamRoster"
import { bulkInviteByEmail } from "./inviteRoster"
import { log } from "./rosterPrimitives"

// Dismiss one entry of the org's failed_invitations list (the same DELETE that
// cancels a pending invite; GitHub's UI calls it "dismiss"). Never throws: the
// record is bookkeeping, and the caller's real operation (a fresh invite, a row
// removal) must not fail because a stale record wouldn't go away.
export async function dismissFailedInvitation(
  client: GitHubClient,
  input: { org: string; invitationId: number },
): Promise<void> {
  try {
    await cancelOrgInvitation(client, input)
  } catch (err) {
    log.error("dismissing a failed invitation failed", { ...input, err })
  }
}

export type ReinviteUnlinkedRowInput = {
  org: string
  classroom: string
  email: string
  role: ClassroomRole
  // The failed record the roster already attributed to this row (see
  // TeamRosterRow.failed_invitation). When known, it is dismissed directly; when
  // not, the org's failed list is scanned for the address.
  failedInvitationId?: number
}

export type ReinviteUnlinkedRowResult =
  | { status: "sent" }
  // GitHub answered 422: the address already has a live invitation (one the
  // classroom team can't see) or belongs to an org member. Nothing was sent.
  | { status: "already-invited-or-member" }
  | { status: "rate-limited" }

// Re-invite an unlinked email row: a roster.csv row whose invitation is no
// longer pending (expired, canceled elsewhere, or never deliverable). The row
// itself stays put and is re-claimed by the fresh invite, so the roster flips it
// back to "pending" on the next read.
//
// GitHub has no resend endpoint (see POST/DELETE /orgs/{org}/invitations), so a
// re-invite is cancel + create. Every failed record for the address is dismissed
// first: left in place it keeps the row badged "Invitation expired" after the
// fresh invite is pending. Best-effort; the invite itself is the operation the
// teacher asked for.
export async function reinviteUnlinkedRow(
  client: GitHubClient,
  input: ReinviteUnlinkedRowInput,
): Promise<ReinviteUnlinkedRowResult> {
  const { org, classroom, role, failedInvitationId } = input
  const email = input.email.trim()
  if (!email) throw new Error("reinviteUnlinkedRow requires an email")

  if (failedInvitationId !== undefined) {
    await dismissFailedInvitation(client, {
      org,
      invitationId: failedInvitationId,
    })
  }
  // Scan for any other record on the address (an earlier expiry the roster
  // didn't surface because it keeps only the latest). A failed list read is
  // owner-only, so a 403/404 just skips the sweep.
  const wanted = email.toLowerCase()
  const failed = await tolerateGitHubError(
    () => getOrgFailedInvitations(client, org),
    [],
    { predicate: (err) => err.isNotFound || err.isForbidden },
  )
  for (const inv of failed) {
    if (inv.id === failedInvitationId) continue
    if (inv.email?.trim().toLowerCase() !== wanted) continue
    await dismissFailedInvitation(client, { org, invitationId: inv.id })
  }

  const res = await bulkInviteByEmail(client, {
    org,
    classroom,
    invites: [{ email, role }],
  })
  const failure = res.failed[0]
  if (failure) throw new Error(failure.message)
  if (res.deferred.length > 0) return { status: "rate-limited" }
  if (res.invited.length > 0) return { status: "sent" }
  return { status: "already-invited-or-member" }
}
