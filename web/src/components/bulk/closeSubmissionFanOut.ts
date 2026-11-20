import type { TFunction } from "i18next"

import type { RepoPermission } from "@/types/classroom"

import { runBulkRepoAccess } from "./repoAccessFanOut"
import type { FanOutOutcome } from "./fanOut"

// One selected assignment and the accepted owners whose own repo the run has
// to touch. An assignment nobody accepted carries no owners and costs no
// writes — its window flag still flips.
export type CloseSubmissionTarget = { slug: string; owners: string[] }

// A per-owner outcome carrying the assignment it belongs to, so the result
// view can name `slug`/`owner` rather than an owner who appears under several
// assignments.
export type BulkCloseOutcome = FanOutOutcome & { slug: string }

export type BulkCloseResult = {
  outcomes: BulkCloseOutcome[]
  rateLimited: boolean
}

type RunBulkCloseSubmissionParams = {
  targets: CloseSubmissionTarget[]
  org: string
  classroom: string
  permission: RepoPermission
  setCollaborator: Parameters<typeof runBulkRepoAccess>[0]["setCollaborator"]
  treatRequestedAsFloor: boolean
  t: TFunction
  isMounted: () => boolean
  // The running count across every target's owners, so one bar covers the
  // whole selection.
  onProgress: (processed: number) => void
}

// The whole-selection counterpart of runBulkRepoAccess: the same bounded
// per-repo fan-out, run once per selected assignment. The assignments go one
// after another rather than in parallel — each inner run already saturates the
// shared write concurrency, and a secondary rate limit has to stop the REST of
// the selection, not just the assignment that tripped it. Once it trips, every
// remaining owner is reported deferred without a request, exactly as the
// single-assignment run does within one assignment.
export async function runBulkCloseSubmission({
  targets,
  org,
  classroom,
  permission,
  setCollaborator,
  treatRequestedAsFloor,
  t,
  isMounted,
  onProgress,
}: RunBulkCloseSubmissionParams): Promise<BulkCloseResult> {
  const outcomes: BulkCloseOutcome[] = []
  let processed = 0
  let rateLimited = false

  for (const target of targets) {
    if (rateLimited || !isMounted()) {
      for (const owner of target.owners) {
        outcomes.push({ owner, slug: target.slug, status: "deferred" })
        processed += 1
      }
      if (isMounted()) onProgress(processed)
      continue
    }

    const before = processed
    const result = await runBulkRepoAccess({
      owners: target.owners,
      org,
      classroom,
      assignment: target.slug,
      permission,
      setCollaborator,
      treatRequestedAsFloor,
      t,
      isMounted,
      onProgress: (done) => {
        processed = before + done
        onProgress(processed)
      },
    })
    processed = before + target.owners.length
    outcomes.push(
      ...result.outcomes.map((outcome) => ({ ...outcome, slug: target.slug })),
    )
    if (result.rateLimited) rateLimited = true
  }

  return { outcomes, rateLimited }
}
