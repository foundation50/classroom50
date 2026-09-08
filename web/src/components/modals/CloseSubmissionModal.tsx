import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { CalendarIcon } from "@/components/ui/icons"

import { Alert, Button, Modal, ModalIcon } from "@/components/ui"
import { BulkProgressBlock, BulkResultBody } from "@/components/bulk/resultView"
import { partitionOutcomes } from "@/components/bulk/fanOut"
import { runBulkRepoAccess } from "@/components/bulk/repoAccessFanOut"
import { useBulkRun } from "@/components/bulk/useBulkRun"
import useAddRepoCollaborator from "@/hooks/mutations/useAddRepoCollaborator"
import useSetAssignmentClosed from "@/hooks/mutations/useSetAssignmentClosed"
import { getName } from "@/util/students"
import type { RepoPermission, Student } from "@/types/classroom"

type CloseSubmissionModalProps = {
  open: boolean
  onClose: () => void
  org: string
  classroom: string
  assignment: string
  // "close" ends the submission window (block new accepts, repos -> read);
  // "reopen" reverses it (allow accepts, repos -> write).
  mode: "close" | "reopen"
  // The accepted students (their own login = their repo's owner segment).
  owners: string[]
  students?: Student[]
}

// Close/reopen the submission window as one action: flip the assignment's
// `closed` flag, then fan out over the accepted set setting each student's role
// on their OWN repo (read on close, write on reopen). Sibling of
// BulkRepoAccessModal — reuses its bounded-fan-out shape, but the permission is
// fixed by `mode` and the flag flip runs first (so new accepts are blocked even
// if the fan-out is partially throttled). Individual assignments only.
export function CloseSubmissionModal({
  open,
  onClose,
  org,
  classroom,
  assignment,
  mode,
  owners,
  students = [],
}: CloseSubmissionModalProps) {
  const { t } = useTranslation()
  const closing = mode === "close"
  const permission: RepoPermission = closing ? "pull" : "push"
  const addCollaboratorMutation = useAddRepoCollaborator()
  const setClosed = useSetAssignmentClosed(org, classroom)
  const bulk = useBulkRun(open)
  const { phase, progress, result, busy } = bulk
  // The flag write failed before any repo was touched; `bulk.error` carries
  // the phase, this carries which alert to show.
  const [flagError, setFlagError] = useState(false)
  // True after a close run that flipped the flag but left some repos not
  // read-only (deferred/failed). The flag is committed (new accepts are
  // blocked), so the recovery is to re-run the read-only fan-out WITHOUT
  // reopening — reopening would re-grant write first. Drives the "finish
  // closing" affordance so a throttled close isn't stuck offering only Reopen.
  const [fanOutIncomplete, setFanOutIncomplete] = useState(false)

  // The modal's own flags reset with the run state, on open (see useBulkRun).
  useEffect(() => {
    if (!open) return
    setFlagError(false)
    setFanOutIncomplete(false)
  }, [open])

  const total = owners.length
  const displayFor = (login: string) => getName(login, students) || login

  // Set every accepted student's role on their own repo. `flipFlag` runs the
  // full close/reopen (flag flip first, then fan-out); `finishOnly` skips the
  // flag flip and re-runs just the fan-out to finish an interrupted close.
  const run = async ({ flipFlag }: { flipFlag: boolean }) => {
    if (!bulk.begin(total)) return
    setFlagError(false)
    setFanOutIncomplete(false)

    // Flip the window flag FIRST: closing must block new accepts even if the
    // per-repo fan-out is later throttled or partially fails. If this write
    // fails, don't touch any repo — surface the error and stop.
    if (flipFlag) {
      try {
        await setClosed.mutateAsync({
          org,
          classroom,
          slug: assignment,
          closed: closing,
        })
      } catch {
        if (bulk.isMounted()) setFlagError(true)
        bulk.fail(t("submissions.closeSubmission.flagError"))
        return
      }
    }

    const { outcomes, rateLimited } = await runBulkRepoAccess({
      owners,
      org,
      classroom,
      assignment,
      permission,
      setCollaborator: (params) => addCollaboratorMutation.mutateAsync(params),
      // On close (downgrade to pull), a residual role ABOVE pull is the
      // over-access a lockdown must catch, so compare exactly. On reopen
      // (restore push), a residual at or above write is benign — treat the
      // requested level as a floor so a student who legitimately holds more
      // than push isn't a false failure.
      treatRequestedAsFloor: !closing,
      t,
      isMounted: bulk.isMounted,
      onProgress: (processed) =>
        bulk.setProgress({ processed, total, message: "" }),
    })
    if (!bulk.isMounted()) return

    const { succeeded, deferred, failed } = partitionOutcomes(outcomes)

    const headlineKey = rateLimited
      ? closing
        ? "submissions.closeSubmission.resultHeadlineThrottled"
        : "submissions.closeSubmission.reopenResultHeadlineThrottled"
      : closing
        ? "submissions.closeSubmission.resultHeadline"
        : "submissions.closeSubmission.reopenResultHeadline"

    // Closing left some repos not read-only: the flag is committed, so offer a
    // finish-only re-run (no reopen) instead of stranding the teacher.
    setFanOutIncomplete(closing && (failed.length > 0 || deferred.length > 0))
    bulk.complete(
      {
        headline: t(headlineKey, { count: succeeded.length, total }),
        sections: [
          ...(failed.length
            ? [
                {
                  title: t("submissions.closeSubmission.failedSection", {
                    count: failed.length,
                  }),
                  rows: failed.map((o) => ({
                    key: o.owner,
                    label: displayFor(o.owner),
                    detail: o.detail,
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
                  rows: deferred.map((o) => ({
                    key: o.owner,
                    label: displayFor(o.owner),
                    detail: t("submissions.closeSubmission.deferredDetail"),
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
          ? t("submissions.closeSubmission.title")
          : t("submissions.closeSubmission.reopenTitle")
      }
      subtitle={
        closing
          ? t("submissions.closeSubmission.subtitle", { count: total })
          : t("submissions.closeSubmission.reopenSubtitle", {
              count: total,
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
                  ? t("submissions.closeSubmission.apply")
                  : t("submissions.closeSubmission.reopenApply")}
              </Button>
            )}
          </>
        )
      }
    >
      {phase === "idle" && (
        <div className="mt-4 flex flex-col gap-4">
          {total === 0 ? (
            <Alert tone="info" className="text-sm">
              {t("submissions.closeSubmission.noRepos")}
            </Alert>
          ) : (
            <Alert tone="warning" className="text-sm">
              {closing
                ? t("submissions.closeSubmission.warning", { count: total })
                : t("submissions.closeSubmission.reopenWarning", {
                    count: total,
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

export default CloseSubmissionModal
