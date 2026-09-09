import type { GitHubClient } from "@/github-core/client"
import { cancelOrgInvitation } from "@/github-core/mutations"
import { getOrgFailedInvitations } from "@/github-core/queries"
import { tolerateGitHubError } from "@/github-core/errors"
import type { ClassroomRole } from "@/util/teamRoster"
import { bulkInviteByEmail } from "./inviteRoster"
import { log } from "./rosterPrimitives"

export type ReinviteUnlinkedRowInput = {
  org: string
  classroom: string
  email: string
  role: ClassroomRole
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
// re-invite is cancel + create. Any failed record for the address is dismissed
// first, the same recipe as the Failed-invitations "Re-invite": left in place it
// keeps listing the student below the table after the row has moved on. The
// failed list is owner-only and best-effort here; the invite itself is the
// operation the teacher asked for.
export async function reinviteUnlinkedRow(
  client: GitHubClient,
  input: ReinviteUnlinkedRowInput,
): Promise<ReinviteUnlinkedRowResult> {
  const { org, classroom, role } = input
  const email = input.email.trim()
  if (!email) throw new Error("reinviteUnlinkedRow requires an email")

  const wanted = email.toLowerCase()
  const failed = await tolerateGitHubError(
    () => getOrgFailedInvitations(client, org),
    [],
    { predicate: (err) => err.isNotFound || err.isForbidden },
  )
  for (const inv of failed) {
    if (inv.email?.trim().toLowerCase() !== wanted) continue
    try {
      await cancelOrgInvitation(client, { org, invitationId: inv.id })
    } catch (err) {
      log.error("dismissing a failed invitation before re-invite failed", {
        email,
        invitationId: inv.id,
        err,
      })
    }
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
