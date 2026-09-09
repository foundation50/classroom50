import type { GitHubClient } from "@/github-core/client"
import { getOrgFailedInvitations } from "@/github-core/queries"
import { tolerateGitHubError } from "@/github-core/errors"
import type { ClassroomRole } from "@/util/teamRoster"
import { bulkInviteByEmail, type BulkInviteByEmailResult } from "./inviteRoster"

export { dismissFailedInvitation } from "./rosterPrimitives"

export type EmailReinviteTarget = {
  email: string
  role: ClassroomRole
  // The live invitation to replace (a pending email-only row). GitHub refuses a
  // second invitation for an address that already has one, so a resend must
  // cancel it; bulkInviteByEmail does so right before the create and restores
  // it if the create fails.
  pendingInvitationId?: number
  // The failed record the roster attributed to the row (see
  // TeamRosterRow.failed_invitation), dismissed once the fresh invite is out.
  failedInvitationId?: number
  // Row metadata for an address with no roster row yet (a roster upload):
  // written with the pending row, since nothing else can fill it in before the
  // student has an account. Ignored for an address already on the roster.
  first_name?: string
  last_name?: string
  section?: string
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
// the two can't drift on what "send again" clears.
//
// GitHub has no resend endpoint, so this is cancel + create, and the order
// matters: bulkInviteByEmail runs every batch precondition (archived
// classroom, team resolution) first, cancels each target's live invitation
// right before its own create, restores it when the create fails, and
// dismisses the address's failed records only after the send is confirmed.
// The failed records to dismiss are the ids the roster attributed plus any
// older record for the same address (the roster keeps only the latest); the
// failed list is read once for the whole batch and is owner-only, so a 403/404
// just skips that sweep.
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

  const failedList = await tolerateGitHubError(
    () => getOrgFailedInvitations(client, org),
    [],
    {
      predicate: (err) =>
        !err.isRateLimited && (err.isNotFound || err.isForbidden),
    },
  )
  const failedIdsByEmail = new Map<string, Set<number>>()
  for (const inv of failedList) {
    const email = inv.email?.trim().toLowerCase()
    if (!email) continue
    const ids = failedIdsByEmail.get(email) ?? new Set<number>()
    ids.add(inv.id)
    failedIdsByEmail.set(email, ids)
  }

  return bulkInviteByEmail(client, {
    org,
    classroom,
    invites: targets.map((t) => {
      const ids = new Set(failedIdsByEmail.get(t.email.toLowerCase()))
      if (t.failedInvitationId !== undefined) ids.add(t.failedInvitationId)
      return {
        email: t.email,
        role: t.role,
        first_name: t.first_name,
        last_name: t.last_name,
        section: t.section,
        pendingInvitationId: t.pendingInvitationId,
        failedInvitationIds: ids.size > 0 ? [...ids] : undefined,
      }
    }),
    onProgress,
  })
}

export type ReinviteEmailRowInput = {
  org: string
  classroom: string
  email: string
  role: ClassroomRole
  pendingInvitationId?: number
  failedInvitationId?: number
}

export type ReinviteEmailRowResult =
  | { status: "sent" }
  // GitHub answered 422: the address already has a live invitation (one the
  // classroom team can't see, possibly sent from another classroom) or belongs
  // to an org member. Nothing was sent.
  | { status: "already-invited-or-member" }
  | { status: "rate-limited" }

// The single-row form for the member modal (resend of a pending email row, or
// re-invite of an unlinked one): reinviteEmailRows for one address, folded to a
// status the call site maps to copy. Throws on a real failure.
export async function reinviteEmailRow(
  client: GitHubClient,
  input: ReinviteEmailRowInput,
): Promise<ReinviteEmailRowResult> {
  const { org, classroom, role, pendingInvitationId, failedInvitationId } =
    input
  const email = input.email.trim()
  if (!email) throw new Error("reinviteEmailRow requires an email")

  const res = await reinviteEmailRows(client, {
    org,
    classroom,
    targets: [{ email, role, pendingInvitationId, failedInvitationId }],
  })
  const failure = res.failed[0]
  if (failure) throw new Error(failure.message)
  if (res.deferred.length > 0) return { status: "rate-limited" }
  if (res.invited.length > 0) return { status: "sent" }
  return { status: "already-invited-or-member" }
}
