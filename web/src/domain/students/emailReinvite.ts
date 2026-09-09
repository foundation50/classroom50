import type { GitHubClient } from "@/github-core/client"
import { cancelOrgInvitation } from "@/github-core/mutations"
import { getOrgFailedInvitations } from "@/github-core/queries"
import { tolerateGitHubError } from "@/github-core/errors"
import type { ClassroomRole } from "@/util/teamRoster"
import { bulkInviteByEmail, type BulkInviteByEmailResult } from "./inviteRoster"
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

export type EmailReinviteTarget = {
  email: string
  role: ClassroomRole
  // The live invitation to replace (a pending email-only row). GitHub refuses a
  // second invitation for an address that already has one, so a resend must
  // cancel first; without this the create 422s and nothing is sent.
  pendingInvitationId?: number
  // The failed record the roster attributed to the row (see
  // TeamRosterRow.failed_invitation), dismissed so it stops badging the row.
  failedInvitationId?: number
}

export type ReinviteEmailRowsInput = {
  org: string
  classroom: string
  targets: EmailReinviteTarget[]
  onProgress?: (progress: {
    processed: number
    total: number
    message: string
  }) => void
}

// Send a fresh organization invitation to each email row: a pending email-only
// invite (resend), an unlinked address (re-invite), or one whose invitation
// GitHub recorded as failed. One recipe for the row modal and the bulk bar so
// the two can't drift on what "send again" clears first.
//
// GitHub has no resend endpoint, so this is cancel + create. Before sending:
//   - every pending invitation named by a target is cancelled;
//   - every failed record on a target address is dismissed: the ids the roster
//     attributed, plus any older record for the same address (the roster keeps
//     only the latest). The failed list is read once for the whole batch;
//     owner-only, so a 403/404 just skips that sweep.
// Then bulkInviteByEmail sends the batch with the classroom team attached and
// re-claims each address's existing roster.csv row.
export async function reinviteEmailRows(
  client: GitHubClient,
  input: ReinviteEmailRowsInput,
): Promise<BulkInviteByEmailResult> {
  const { org, classroom, onProgress } = input
  const targets = input.targets
    .map((t) => ({ ...t, email: t.email.trim() }))
    .filter((t) => t.email)
  if (targets.length === 0) {
    return { invited: [], skipped: [], failed: [], deferred: [] }
  }

  const wantedEmails = new Set(targets.map((t) => t.email.toLowerCase()))
  const failedList = await tolerateGitHubError(
    () => getOrgFailedInvitations(client, org),
    [],
    { predicate: (err) => err.isNotFound || err.isForbidden },
  )
  const toDismiss = new Set<number>()
  for (const t of targets) {
    if (t.failedInvitationId !== undefined) toDismiss.add(t.failedInvitationId)
  }
  for (const inv of failedList) {
    const email = inv.email?.trim().toLowerCase()
    if (email && wantedEmails.has(email)) toDismiss.add(inv.id)
  }
  for (const id of toDismiss) {
    await dismissFailedInvitation(client, { org, invitationId: id })
  }

  for (const t of targets) {
    if (t.pendingInvitationId === undefined) continue
    // A 404 (already gone) is tolerated inside cancelOrgInvitation; anything
    // else means the live invite may still block the create, so let it throw
    // rather than report a resend that can't happen.
    await cancelOrgInvitation(client, {
      org,
      invitationId: t.pendingInvitationId,
    })
  }

  return bulkInviteByEmail(client, {
    org,
    classroom,
    invites: targets.map(({ email, role }) => ({ email, role })),
    onProgress,
  })
}

export type ReinviteUnlinkedRowInput = {
  org: string
  classroom: string
  email: string
  role: ClassroomRole
  failedInvitationId?: number
}

export type ReinviteUnlinkedRowResult =
  | { status: "sent" }
  // GitHub answered 422: the address already has a live invitation (one the
  // classroom team can't see) or belongs to an org member. Nothing was sent.
  | { status: "already-invited-or-member" }
  | { status: "rate-limited" }

// The single-row form for the member modal: reinviteEmailRows for one address,
// folded to a status the call site maps to copy. Throws on a real failure.
export async function reinviteUnlinkedRow(
  client: GitHubClient,
  input: ReinviteUnlinkedRowInput,
): Promise<ReinviteUnlinkedRowResult> {
  const { org, classroom, role, failedInvitationId } = input
  const email = input.email.trim()
  if (!email) throw new Error("reinviteUnlinkedRow requires an email")

  const res = await reinviteEmailRows(client, {
    org,
    classroom,
    targets: [{ email, role, failedInvitationId }],
  })
  const failure = res.failed[0]
  if (failure) throw new Error(failure.message)
  if (res.deferred.length > 0) return { status: "rate-limited" }
  if (res.invited.length > 0) return { status: "sent" }
  return { status: "already-invited-or-member" }
}
