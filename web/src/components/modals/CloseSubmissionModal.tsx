import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { CalendarIcon } from "@/components/ui/icons"

import { Alert, Button, Modal, ModalIcon } from "@/components/ui"
import { BulkProgressBlock, BulkResultBody } from "@/components/bulk/resultView"
import {
  failedAndDeferredSections,
  useOwnerDisplayName,
  partitionOutcomes,
} from "@/components/bulk/fanOut"
import {
  isNotApplied,
  runBulkRepoAccess,
} from "@/components/bulk/repoAccessFanOut"
import { useBulkRun } from "@/components/bulk/useBulkRun"
import useAddRepoCollaborator from "@/hooks/mutations/useAddRepoCollaborator"
import useSetAssignmentClosed from "@/hooks/mutations/useSetAssignmentClosed"
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
  // The parent derives `mode` from the assignment's `closed` flag, which this
  // run flips FIRST, so the prop swaps to "reopen" mid-run once the listing
  // refetches. Freeze the direction the run started with: otherwise the
  // "Finish closing" retry (and the title) would follow the prop and re-grant
  // write to every repo (#1152).
  const [startedMode, setStartedMode] = useState<"close" | "reopen" | null>(
    null,
  )
  const closing = (startedMode ?? mode) === "close"
  const permission: RepoPermission = closing ? "pull" : "push"
  const addCollaboratorMutation = useAddRepoCollaborator()
  const setClosed = useSetAssignmentClosed(org, classroom)
  const bulk = useBulkRun(open)
  const { phase, progress, result, busy } = bulk
  // The flag write failed before any repo was touched; `bulk.error` carries
  // the phase, this carries which alert to show.
  const [flagError, setFlagError] = useState(false)
  // Owners a close run left not read-only for a reason a re-run could fix
  // (deferred or transiently failed). The flag is already committed (new
  // accepts are blocked), so the recovery is "Finish closing": re-run the
  // read-only fan-out over just these, WITHOUT reopening, which would re-grant
  // write first. Kept roles (`notApplied`, see BulkAccessOutcome) are left out.
  const [pendingOwners, setPendingOwners] = useState<string[]>([])
  const fanOutIncomplete = pendingOwners.length > 0
  // A close run hit kept roles: explain instead of offering a retry.
  const [hasNotApplied, setHasNotApplied] = useState(false)

  // The modal's own flags reset with the run state, on open (see useBulkRun).
  useEffect(() => {
    if (!open) return
    setStartedMode(null)
    setFlagError(false)
    setPendingOwners([])
    setHasNotApplied(false)
  }, [open])

  const accepted = owners.length
  const displayFor = useOwnerDisplayName(students)

  // Set each target student's role on their own repo. `flipFlag` runs the full
  // close/reopen over every accepted owner (flag flip first, then fan-out); a
  // finish-only run skips the flip and retries just the pending owners.
  const run = async ({ flipFlag }: { flipFlag: boolean }) => {
    const targets = flipFlag ? owners : pendingOwners
    const total = targets.length
    if (!bulk.begin(total)) return
    if (flipFlag) setStartedMode(mode)
    setFlagError(false)
    setPendingOwners([])
    setHasNotApplied(false)

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
      owners: targets,
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
    setPendingOwners(
      closing
        ? outcomes
            .filter((o) => o.status !== "ok" && !isNotApplied(o))
            .map((o) => o.owner)
        : [],
    )
    setHasNotApplied(closing && failed.some(isNotApplied))
    bulk.complete(
      {
        headline: t(headlineKey, { count: succeeded.length, total }),
        sections: failedAndDeferredSections(
          t,
          {
            failed: "submissions.closeSubmission.failedSection",
            deferred: "submissions.closeSubmission.deferredSection",
            deferredDetail: "submissions.closeSubmission.deferredDetail",
          },
          { failed, deferred },
          displayFor,
        ),
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
          ? t("submissions.closeSubmission.subtitle", { count: accepted })
          : t("submissions.closeSubmission.reopenSubtitle", {
              count: accepted,
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
          {accepted === 0 ? (
            <Alert tone="info" className="text-sm">
              {t("submissions.closeSubmission.noRepos")}
            </Alert>
          ) : (
            <Alert tone="warning" className="text-sm">
              {closing
                ? t("submissions.closeSubmission.warning", { count: accepted })
                : t("submissions.closeSubmission.reopenWarning", {
                    count: accepted,
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
          <>
            {fanOutIncomplete && (
              <Alert tone="info" className="text-sm">
                {t("submissions.closeSubmission.finishHint")}
              </Alert>
            )}
            {hasNotApplied && (
              <Alert tone="info" className="text-sm">
                <div className="flex flex-col gap-2">
                  <p>{t("submissions.closeSubmission.notAppliedHint.lead")}</p>
                  <ul className="list-disc ps-5">
                    <li>
                      {t("submissions.closeSubmission.notAppliedHint.owner")}
                    </li>
                    <li>
                      {t("submissions.closeSubmission.notAppliedHint.admin")}
                    </li>
                    <li>
                      {t("submissions.closeSubmission.notAppliedHint.team")}
                    </li>
                  </ul>
                  <p>{t("submissions.closeSubmission.notAppliedHint.next")}</p>
                </div>
              </Alert>
            )}
          </>
        }
      />
    </Modal>
  )
}

export default CloseSubmissionModal
