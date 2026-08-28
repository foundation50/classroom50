import type { GitHubClient } from "@/github-core/client"
import type { TFunction } from "i18next"
import { getAuthenticatedUser } from "@/domain/queries/users"
import { getErrorMessage } from "@/github-core/errorMessage"
import { isSameGitHubUser } from "@/util/students"
import type { OrgMemberRow } from "@/util/orgMembers"
import { removeMemberFromOrg } from "@/domain/orgMembers/removeMemberFromOrg"
import type { BulkRemoveProgress } from "@/domain/orgMembers/bulkRemoveFromClassroom"
import { logger } from "@/lib/logger"

const log = logger.scope("orgMembers:bulkRemoveFromOrg")

export type BulkRemoveFromOrgOutcome = {
  key: string
  label: string
  status: "removed" | "skipped" | "failed"
  // A stable skip-reason token, or the failure message.
  detail?: string
  // Classrooms the member was unenrolled from before the org DELETE.
  unenrolledClassrooms: string[]
}

export type BulkRemoveFromOrgResult = {
  outcomes: BulkRemoveFromOrgOutcome[]
  removedCount: number
  // Non-fatal side-effect warnings accumulated across members (archived
  // rosters, per-classroom unenroll failures).
  warnings: string[]
}

const labelFor = (row: OrgMemberRow) => row.username || row.email || row.key

// Remove selected members from the ORGANIZATION, one at a time. Each member
// goes through removeMemberFromOrg, which unenrolls them from EVERY classroom
// they belong to first and deletes the org membership last — so a partial
// failure never strips membership while rosters still list the student. That
// deliberately includes classrooms beyond the one the teacher filtered by;
// the confirm UI surfaces that blast radius before this runs.
//
// The org-wide DELETE is effectively irreversible from the app, so the
// viewer is verified ONCE up front and the whole run fails closed when the
// account can't be resolved (mirroring the single-row path).
export async function bulkRemoveFromOrg(
  client: GitHubClient,
  input: {
    org: string
    rows: OrgMemberRow[]
    onProgress?: (progress: BulkRemoveProgress) => void
  },
  t?: TFunction,
): Promise<BulkRemoveFromOrgResult> {
  const { org, rows, onProgress } = input

  const viewer = await getAuthenticatedUser(client).catch((err: unknown) => {
    log.warn("bulk remove from org: viewer resolution failed", { org, err })
    return null
  })
  if (!viewer) {
    throw new Error(
      t
        ? t("orgMembers.bulk.viewerUnverified")
        : "Couldn't verify your account, so no members were removed. Please try again.",
    )
  }

  const outcomes: BulkRemoveFromOrgOutcome[] = []
  const warnings: string[] = []
  let processed = 0
  const tick = (label: string) => {
    processed += 1
    onProgress?.({ processed, total: rows.length, message: label })
  }

  for (const row of rows) {
    const label = labelFor(row)

    // Selection already excludes the signed-in account, but that gate is
    // UI-only; re-check against the server-resolved viewer per row.
    if (
      isSameGitHubUser(viewer, {
        github_id: row.github_id,
        username: row.username,
      })
    ) {
      outcomes.push({
        key: row.key,
        label,
        status: "skipped",
        detail: "self",
        unenrolledClassrooms: [],
      })
      tick(label)
      continue
    }
    // The org-membership DELETE is keyed by username; without one there is
    // nothing this action can remove (removeMemberFromOrg would bail the same
    // way — this pre-check just keeps the outcome a clean skip).
    if (!row.username) {
      outcomes.push({
        key: row.key,
        label,
        status: "skipped",
        detail: "no-username",
        unenrolledClassrooms: [],
      })
      tick(label)
      continue
    }

    try {
      const result = await removeMemberFromOrg(client, { org, row, viewer }, t)
      warnings.push(...result.warnings)
      outcomes.push({
        key: row.key,
        label,
        // removed=false with a username means the org DELETE itself failed
        // (the failure is already in result.warnings).
        status: result.removed ? "removed" : "failed",
        detail: result.removed ? undefined : result.warnings.at(-1),
        unenrolledClassrooms: result.unenrolledClassrooms,
      })
    } catch (err) {
      log.warn("bulk remove from org: per-member removal failed", {
        org,
        err,
      })
      outcomes.push({
        key: row.key,
        label,
        status: "failed",
        detail: getErrorMessage(err),
        unenrolledClassrooms: [],
      })
    }
    tick(label)
  }

  return {
    outcomes,
    removedCount: outcomes.filter((o) => o.status === "removed").length,
    warnings,
  }
}
