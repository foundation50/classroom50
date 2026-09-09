import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import { getErrorMessage } from "@/github-core/errorMessage"
import type { OrgMemberRow } from "@/util/orgMembers"
import { inviteMemberToOrg } from "./inviteMemberToOrg"

export type BulkInviteProgress = {
  processed: number
  total: number
  message: string
}

export type BulkInviteOutcome = {
  key: string
  label: string
  status: "invited" | "skipped" | "failed" | "deferred"
  // skipped: why nothing new was sent; failed: the error.
  detail?: "already-pending" | "already-member" | string
}

export type BulkInviteMembersResult = {
  outcomes: BulkInviteOutcome[]
  invitedCount: number
  // GitHub rate-limited the batch partway; the `deferred` rows were not
  // attempted so a retry later can send them.
  rateLimited: boolean
}

const labelFor = (row: OrgMemberRow) => row.username || row.email || row.key

// Invite every eligible selected row to the org, one at a time through the
// same inviteMemberToOrg the row button uses (by id, classroom teams attached,
// failed record dismissed, pending/active reported rather than re-sent).
// Ineligible rows (not "on roster, not a member", or no usable github_id) are
// skipped up front so the run never touches them. A rate limit stops the loop
// and defers the rest: hammering only extends the throttle.
export async function bulkInviteMembersToOrg(
  client: GitHubClient,
  input: {
    org: string
    rows: OrgMemberRow[]
    onProgress?: (progress: BulkInviteProgress) => void
  },
): Promise<BulkInviteMembersResult> {
  const { org, rows, onProgress } = input
  const outcomes: BulkInviteOutcome[] = []
  let invitedCount = 0
  let rateLimited = false
  const total = rows.length
  let processed = 0
  const bump = (message: string) => {
    processed += 1
    onProgress?.({ processed, total, message })
  }

  for (const row of rows) {
    const label = labelFor(row)
    if (rateLimited) {
      outcomes.push({ key: row.key, label, status: "deferred" })
      bump(label)
      continue
    }
    if (row.classification !== "on-roster-not-member" || !row.github_id) {
      outcomes.push({
        key: row.key,
        label,
        status: "skipped",
        detail:
          row.classification === "invitation-pending"
            ? "already-pending"
            : "not-invitable",
      })
      bump(label)
      continue
    }
    try {
      const result = await inviteMemberToOrg(client, { org, row })
      if (result.state === "invited") {
        invitedCount += 1
        outcomes.push({ key: row.key, label, status: "invited" })
      } else {
        outcomes.push({
          key: row.key,
          label,
          status: "skipped",
          detail:
            result.state === "pending" ? "already-pending" : "already-member",
        })
      }
    } catch (err) {
      // inviteMemberToOrg wraps GitHub errors; the cause carries the status.
      const cause = err instanceof Error ? err.cause : undefined
      if (cause instanceof GitHubAPIError && cause.isRateLimited) {
        rateLimited = true
        outcomes.push({ key: row.key, label, status: "deferred" })
      } else {
        outcomes.push({
          key: row.key,
          label,
          status: "failed",
          detail: getErrorMessage(err),
        })
      }
    }
    bump(label)
  }

  return { outcomes, invitedCount, rateLimited }
}
