import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { Alert, Button, Modal, ModalIcon } from "@/components/ui"
import { CalendarIcon } from "@/components/ui/icons"
import { BulkProgressBlock, BulkResultBody } from "@/components/bulk/resultView"
import { partitionOutcomes } from "@/components/bulk/fanOut"
import {
  runBulkCloseSubmission,
  type CloseSubmissionTarget,
} from "@/components/bulk/closeSubmissionFanOut"
import { useBulkRun } from "@/components/bulk/useBulkRun"
import useAddRepoCollaborator from "@/hooks/mutations/useAddRepoCollaborator"
import { useBulkSetAssignmentClosed } from "@/hooks/mutations/useBulkAssignmentActions"
import type { RepoPermission } from "@/types/classroom"

type BulkCloseSubmissionModalProps = {
  open: boolean
  onClose: () => void
  org: string
  classroom: string
  // "close" ends the submission window (block new accepts, repos -> read);
  // "reopen" reverses it (allow accepts, repos -> write).
  mode: "close" | "reopen"
  // The selected assignments this action covers, each with its accepted owners
  // (their own login = their repo's owner segment). Resolving them is the
  // page's job: the accepted-owner rule reads the org repo list and the roster.
  targets: CloseSubmissionTarget[]
  // Selected assignments the action leaves alone (group/team repos are
  // founder-managed, empty_repo assignments have no student repo to downgrade),
  // by slug. Named up front so the selection count and the run agree.
  skipped: string[]
}

// The plural CloseSubmissionModal: close or reopen the submission window for a
// whole selection. One commit flips `closed` on every selected assignment, then
// the per-repo fan-out runs once per assignment, exactly as the
// single-assignment modal does — flag first, so a throttled run still blocks
// new accepts, and the same finish-closing re-run recovers a close whose
// repositories were left writable.
export function BulkCloseSubmissionModal({
  open,
  onClose,
  org,
  classroom,
  mode,
  targets,
  skipped,
}: BulkCloseSubmissionModalProps) {
  const { t } = useTranslation()
  const closing = mode === "close"
  const permission: RepoPermission = closing ? "pull" : "push"
  const addCollaboratorMutation = useAddRepoCollaborator()
  const setClosed = useBulkSetAssignmentClosed(org, classroom)
  const bulk = useBulkRun(open)
  const { phase, progress, result, busy } = bulk
  // The commit failed before any repository was touched; `bulk.error` carries
  // the phase, this carries which alert to show.
  const [flagError, setFlagError] = useState(false)
  // True after a close that committed the flag but left some repositories
  // writable (deferred/failed). Reopening would re-grant write first, so the
  // recovery is a fan-out-only re-run — same reasoning as CloseSubmissionModal.
  const [fanOutIncomplete, setFanOutIncomplete] = useState(false)

  useEffect(() => {
    if (!open) return
    setFlagError(false)
    setFanOutIncomplete(false)
  }, [open])

  const assignmentTotal = targets.length
  const repoTotal = targets.reduce((sum, one) => sum + one.owners.length, 0)

  // `flipFlag` runs the whole action (commit, then fan-out); `finishOnly`
  // re-runs just the fan-out to finish an interrupted close.
  const run = async ({ flipFlag }: { flipFlag: boolean }) => {
    if (!bulk.begin(repoTotal)) return
    setFlagError(false)
    setFanOutIncomplete(false)

    // Commit the window flag FIRST: closing must block new accepts even if the
    // per-repo fan-out is later throttled. One commit for the selection, so a
    // failure here changed nothing at all.
    let changed = flipFlag ? 0 : assignmentTotal
    let missing: string[] = []
    if (flipFlag) {
      try {
        const write = await setClosed.mutateAsync({
          slugs: targets.map((one) => one.slug),
          closed: closing,
        })
        changed = write.changed.length
        missing = write.missing
      } catch {
        if (bulk.isMounted()) setFlagError(true)
        bulk.fail(t("submissions.closeSubmission.flagError"))
        return
      }
    }

    // An assignment deleted between render and submit has no repositories to
    // reach either; its owners would 404 one by one.
    const gone = new Set(missing)
    const { outcomes, rateLimited } = await runBulkCloseSubmission({
      targets: targets.filter((one) => !gone.has(one.slug)),
      org,
      classroom,
      permission,
      setCollaborator: (params) => addCollaboratorMutation.mutateAsync(params),
      // Same asymmetry as the single-assignment run: closing compares exactly
      // (a residual above pull is the over-access a lockdown must catch),
      // reopening treats the requested level as a floor.
      treatRequestedAsFloor: !closing,
      t,
      isMounted: bulk.isMounted,
      onProgress: (processed) =>
        bulk.setProgress({ processed, total: repoTotal, message: "" }),
    })
    if (!bulk.isMounted()) return

    const { succeeded, deferred, failed } = partitionOutcomes(outcomes)
    const headlineKey = rateLimited
      ? closing
        ? "assignments.bulk.closeSubmission.resultHeadlineThrottled"
        : "assignments.bulk.closeSubmission.reopenResultHeadlineThrottled"
      : closing
        ? "assignments.bulk.closeSubmission.resultHeadline"
        : "assignments.bulk.closeSubmission.reopenResultHeadline"

    setFanOutIncomplete(closing && (failed.length > 0 || deferred.length > 0))
    bulk.complete(
      {
        headline: t(headlineKey, {
          count: changed,
          total: assignmentTotal,
          repos: succeeded.length,
          repoTotal,
        }),
        sections: [
          ...(failed.length
            ? [
                {
                  title: t("submissions.closeSubmission.failedSection", {
                    count: failed.length,
                  }),
                  rows: failed.map((outcome) => ({
                    key: `${outcome.slug}/${outcome.owner}`,
                    label: `${outcome.slug} — ${outcome.owner}`,
                    detail: outcome.detail,
                  })),
                },
              ]
            : []),
          ...(deferred.length
            ? [
                {
                  title: t("submissions.closeSubmission.deferredSection", {
                    count: deferred.length,
                  }),
                  rows: deferred.map((outcome) => ({
                    key: `${outcome.slug}/${outcome.owner}`,
                    label: `${outcome.slug} — ${outcome.owner}`,
                    detail: t("submissions.closeSubmission.deferredDetail"),
                  })),
                },
              ]
            : []),
          ...(missing.length
            ? [
                {
                  title: t("assignments.bulk.closeSubmission.missingSection", {
                    count: missing.length,
                  }),
                  rows: missing.map((slug) => ({
                    key: `missing/${slug}`,
                    label: slug,
                    detail: t("assignments.bulk.missingDetail"),
                  })),
                },
              ]
            : []),
        ],
      },
      failed.length || deferred.length ? "error" : "complete",
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={busy}
      size="lg"
      title={
        closing
          ? t("assignments.bulk.closeSubmission.title")
          : t("assignments.bulk.closeSubmission.reopenTitle")
      }
      subtitle={
        closing
          ? t("assignments.bulk.closeSubmission.subtitle", {
              count: assignmentTotal,
            })
          : t("assignments.bulk.closeSubmission.reopenSubtitle", {
              count: assignmentTotal,
            })
      }
      headerVisual={
        <ModalIcon tone="warning">
          <CalendarIcon className="size-4" aria-hidden="true" />
        </ModalIcon>
      }
      footer={
        phase === "complete" || phase === "error" ? (
          fanOutIncomplete ? (
            <>
              <Button variant="ghost" onClick={() => onClose()}>
                {t("common.close")}
              </Button>
              <Button
                variant="primary"
                onClick={() => void run({ flipFlag: false })}
              >
                {t("submissions.closeSubmission.finishApply")}
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => onClose()}>
              {t("common.done")}
            </Button>
          )
        ) : (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => onClose()}>
              {t("common.cancel")}
            </Button>
            {phase === "idle" && (
              <Button
                variant="primary"
                onClick={() => void run({ flipFlag: true })}
              >
                {closing
                  ? t("assignments.bulk.closeSubmission.apply")
                  : t("assignments.bulk.closeSubmission.reopenApply")}
              </Button>
            )}
          </>
        )
      }
    >
      {phase === "idle" && (
        <div className="mt-4 flex flex-col gap-4">
          <Alert tone="warning" className="text-sm">
            {closing
              ? t("assignments.bulk.closeSubmission.warning", {
                  count: repoTotal,
                  assignments: assignmentTotal,
                })
              : t("assignments.bulk.closeSubmission.reopenWarning", {
                  count: repoTotal,
                  assignments: assignmentTotal,
                })}
          </Alert>
          {repoTotal === 0 && closing && (
            <Alert tone="info" className="text-sm">
              {t("assignments.bulk.closeSubmission.noRepos")}
            </Alert>
          )}
          {skipped.length > 0 && (
            <Alert tone="info" className="text-sm">
              {t("assignments.bulk.closeSubmission.skipped", {
                count: skipped.length,
                slugs: skipped.join(", "),
              })}
            </Alert>
          )}
        </div>
      )}

      {busy && (
        <BulkProgressBlock
          workingLabel={t("submissions.closeSubmission.working")}
          indeterminateUntilFirst
          progress={progress}
          caption={
            progress.processed > 0
              ? t("submissions.closeSubmission.progress", {
                  processed: progress.processed,
                  total: progress.total,
                })
              : t("submissions.closeSubmission.working")
          }
        />
      )}

      {phase === "error" && flagError && (
        <div className="mt-4">
          <Alert tone="error" className="text-sm">
            {t("submissions.closeSubmission.flagError")}
          </Alert>
        </div>
      )}

      <BulkResultBody
        phase={phase}
        result={result}
        after={
          fanOutIncomplete ? (
            <Alert tone="info" className="text-sm">
              {t("submissions.closeSubmission.finishHint")}
            </Alert>
          ) : null
        }
      />
    </Modal>
  )
}

export default BulkCloseSubmissionModal
