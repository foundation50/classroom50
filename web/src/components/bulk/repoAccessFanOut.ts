import type { TFunction } from "i18next"

import { describeGitHubApiFailure } from "@/components/modals/collaboratorHelpers"
import { REPO_READ_CONCURRENCY } from "@/github-core/queries"
import { permissionSatisfies } from "@/domain/assignments/permissions"
import { mapWithConcurrency } from "@/util/concurrency"
import { studentRepoName } from "@/util/studentRepo"
import { GitHubAPIError } from "@/github-core/errors"
import type { RepoPermission } from "@/types/classroom"

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

// Map a rejected write to a localized reason for the result table. Reuses the
// groupCollaborators failure vocabulary so every bulk-access dialog stays
// consistent instead of assembling raw English.
export const describeAccessFailure = (
  reason: unknown,
  t: TFunction,
): string | undefined => {
  if (reason instanceof AccessNotAppliedError) {
    return t("components.modals.repoAccess.notApplied", {
      effective: reason.effective ?? "unknown",
    })
  }
  const shared = describeGitHubApiFailure(reason, t)
  if (shared) return shared
  if (reason instanceof GitHubAPIError) {
    return t("components.modals.groupCollaborators.failure.httpStatus", {
      status: reason.status,
    })
  }
  return reason instanceof Error ? reason.message : undefined
}

export type BulkAccessOutcome =
  | { owner: string; status: "ok" }
  | { owner: string; status: "deferred" }
  | { owner: string; status: "failed"; detail?: string }

export type BulkAccessResult = {
  outcomes: BulkAccessOutcome[]
  // True once a secondary rate-limit tripped: the remaining owners were marked
  // deferred rather than launched, so the caller should offer a re-run.
  rateLimited: boolean
}

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
  // Called just before an owner's write is launched, so the UI can show which
  // student is in flight immediately rather than only after the write resolves
  // (important for a single slow write, where processed stays 0 until it lands).
  onStart?: (owner: string) => void
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
  onStart,
  onProgress,
}: RunBulkRepoAccessParams): Promise<BulkAccessResult> {
  let processed = 0
  // Set once we hit a secondary rate-limit: stop launching NEW writes and
  // report the untouched remainder as deferred rather than hammering GitHub
  // into a deeper throttle.
  let rateLimited = false

  const outcomes = await mapWithConcurrency(
    owners,
    REPO_READ_CONCURRENCY,
    async (owner): Promise<BulkAccessOutcome> => {
      // The caller unmounted, or an earlier task tripped the rate limit: don't
      // start another write; mark the rest deferred.
      if (rateLimited || !isMounted()) {
        processed += 1
        if (isMounted()) onProgress(processed, owner)
        return { owner, status: "deferred" }
      }
      if (isMounted()) onStart?.(owner)
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
        return { owner, status: "ok" }
      } catch (err) {
        if (err instanceof GitHubAPIError && err.isRateLimited) {
          rateLimited = true
          return { owner, status: "deferred" }
        }
        return {
          owner,
          status: "failed",
          detail: describeAccessFailure(err, t),
        }
      } finally {
        processed += 1
        if (isMounted()) onProgress(processed, owner)
      }
    },
  )

  return { outcomes, rateLimited }
}
