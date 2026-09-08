import type { TFunction } from "i18next"

import { describeWriteFailure } from "@/components/modals/collaboratorHelpers"
import { permissionSatisfies } from "@/domain/assignments/permissions"
import { studentRepoName } from "@/util/studentRepo"
import type { RepoPermission } from "@/types/classroom"

import { runBulkFanOut, type FanOutOutcome, type FanOutResult } from "./fanOut"

// A verified write GitHub silently ignored: the PUT returned 204 but the
// student's effective role didn't land on the target. Reported distinctly from
// a hard error so callers can surface "still <role>" instead of an HTTP status.
export class AccessNotAppliedError extends Error {
  readonly effective: string | undefined
  constructor(effective: string | undefined) {
    super(`access not applied (still ${effective ?? "unchanged"})`)
    this.name = "AccessNotAppliedError"
    this.effective = effective
  }
}

// The shared write-failure reasons plus the one this fan-out adds.
export const describeAccessFailure = (
  reason: unknown,
  t: TFunction,
): string | undefined => {
  if (reason instanceof AccessNotAppliedError) {
    return t("components.modals.repoAccess.notApplied", {
      effective: reason.effective ?? "unknown",
    })
  }
  return describeWriteFailure(reason, t)
}

export type BulkAccessOutcome = FanOutOutcome
export type BulkAccessResult = FanOutResult<BulkAccessOutcome>

type RunBulkRepoAccessParams = {
  owners: string[]
  org: string
  classroom: string
  assignment: string
  permission: RepoPermission
  // Set every accepted student's role on their OWN repo. Returns the verified
  // effective permission (undefined when the read-back lagged / 404'd).
  setCollaborator: (params: {
    org: string
    repo: string
    username: string
    permission: RepoPermission
    verify: boolean
  }) => Promise<{ effective?: { permission?: string; role_name?: string } }>
  // How a residual (read-back) role is judged against the requested one:
  //   - false (exact "=="): a residual ABOVE the requested role is the
  //     over-access a downgrade must catch — fail loudly. Use for a lockdown.
  //   - true (">=" floor): a residual at or above the requested role is benign;
  //     only a read-back BELOW it fails. Use when restoring/raising access.
  treatRequestedAsFloor: boolean
  t: TFunction
  // Guards setState-after-unmount and lets an in-flight run stop launching new
  // writes when the caller unmounts mid-fan-out.
  isMounted: () => boolean
  // Called after each owner is processed (success, failure, or deferral) with
  // the running processed count and the owner just handled.
  onProgress: (processed: number, owner: string) => void
}

// The shared bounded repo-access fan-out used by every whole-assignment access
// action (set-access, close/reopen submission). Sets each accepted student's
// role on their own repo with bounded concurrency, verifies the effective role,
// short-circuits the remainder to `deferred` on a secondary rate-limit, and
// reports per-owner outcomes. The permission and the residual-role comparison
// are the only axes callers vary.
export async function runBulkRepoAccess({
  owners,
  org,
  classroom,
  assignment,
  permission,
  setCollaborator,
  treatRequestedAsFloor,
  t,
  isMounted,
  onProgress,
}: RunBulkRepoAccessParams): Promise<BulkAccessResult> {
  return runBulkFanOut<BulkAccessOutcome>({
    owners,
    isMounted,
    onProgress,
    t,
    perOwner: async (owner) => {
      const repo = studentRepoName(classroom, assignment, owner)
      try {
        const { effective } = await setCollaborator({
          org,
          repo,
          username: owner,
          permission,
          verify: true,
        })
        if (
          effective &&
          !permissionSatisfies(
            effective.permission,
            effective.role_name,
            permission,
            treatRequestedAsFloor,
          )
        ) {
          throw new AccessNotAppliedError(
            effective.role_name || effective.permission,
          )
        }
      } catch (err) {
        // The generic fan-out only knows the shared vocabulary; give the
        // not-applied case its own line before it becomes a plain failure.
        if (err instanceof AccessNotAppliedError) {
          return {
            owner,
            status: "failed",
            detail: describeAccessFailure(err, t),
          }
        }
        throw err
      }
    },
  })
}
