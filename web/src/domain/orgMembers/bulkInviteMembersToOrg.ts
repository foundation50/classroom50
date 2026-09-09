import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import { getErrorMessage } from "@/github-core/errorMessage"
import {
  isInvitableToOrg,
  orgMemberLabel,
  type OrgMemberRow,
} from "@/util/orgMembers"
import { inviteMemberToOrg, type TeamIdCache } from "./inviteMemberToOrg"

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

// Invite every eligible selected row to the org, one at a time through the
// same inviteMemberToOrg the row button uses (by id, classroom teams attached,
// failed record dismissed after the send, pending/active reported rather than
// re-sent). Ineligible rows (see isInvitableToOrg) are skipped up front so the
// run never touches them. Classroom team ids are resolved once per run. A rate
// limit, whether on the send or on a team read, stops the loop and defers the
// rest: hammering only extends the throttle.
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
  const teamIdCache: TeamIdCache = new Map()

  for (const row of rows) {
    const label = orgMemberLabel(row)
    if (rateLimited) {
      outcomes.push({ key: row.key, label, status: "deferred" })
      bump(label)
      continue
    }
    if (!isInvitableToOrg(row)) {
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
      const result = await inviteMemberToOrg(client, { org, row, teamIdCache })
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
      // inviteMemberToOrg wraps the send's GitHub error (the cause carries the
      // status); a team read that failed throws the GitHubAPIError itself.
      const cause = err instanceof Error ? err.cause : undefined
      const rateLimitHit = [err, cause].some(
        (e) => e instanceof GitHubAPIError && e.isRateLimited,
      )
      if (rateLimitHit) {
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
