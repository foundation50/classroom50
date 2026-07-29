import { useEffect, useId } from "react"
import { Trans, useTranslation } from "react-i18next"
import { FileArchive } from "lucide-react"

import { Alert, Button, Modal, Spinner } from "@/components/ui"
import useDownloadAllSubmissions from "@/hooks/mutations/useDownloadAllSubmissions"
import {
  BULK_DOWNLOAD_WARN_THRESHOLD,
  ZipAssemblyError,
} from "@/domain/assignments"
import type { DownloadRepoResult } from "@/domain/assignments"

// A warning Alert listing the owners in one non-fetched bucket (empty /
// failed). `showReason` appends each owner's reason inline (the failed bucket).
function OwnerListAlert({
  owners,
  title,
  hint,
  showReason,
}: {
  owners: DownloadRepoResult[]
  title: string
  hint: string
  showReason?: boolean
}) {
  return (
    <Alert tone="warning">
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <ul className="max-h-40 overflow-y-auto text-xs">
          {owners.map((r) => (
            <li key={r.owner} className="font-mono">
              {r.owner}
              {showReason && r.reason ? ` — ${r.reason}` : ""}
            </li>
          ))}
        </ul>
        <p className="text-xs text-base-content/70">{hint}</p>
      </div>
    </Alert>
  )
}

// Bulk "Download all submissions" for an assignment. Three states in one
// dialog: confirm (owner count), running (live X/N progress, dismissal
// blocked), and summary (downloaded / empty / failed). The combined zip is
// handed to the browser when the run finishes with at least one fetched repo.
export function DownloadAllSubmissionsModal({
  open,
  onClose,
  org,
  classroom,
  assignment,
  assignmentName,
  owners,
}: {
  open: boolean
  onClose: () => void
  org: string
  classroom: string
  assignment: string
  assignmentName: string
  // Every owner (student login or group owner) with a submission to fetch.
  owners: string[]
}) {
  const { t } = useTranslation()
  const titleId = useId()
  const {
    mutate,
    isPending,
    data: outcome,
    error,
    progress,
    cancel,
    reset,
  } = useDownloadAllSubmissions()

  const count = owners.length
  const running = isPending
  // The run finished with a real result (not a picker cancel).
  const summary = outcome?.status === "done" ? outcome.summary : null
  const toDirectory = outcome?.status === "done" && outcome.toDirectory
  // Assembly (out-of-memory) failure is distinct from a per-repo failure: every
  // archive downloaded but the combined zip couldn't be built. Anything else is
  // an unexpected batch-level error.
  const assemblyError = error instanceof ZipAssemblyError

  // The user dismissed the directory picker before anything ran — close quietly
  // rather than showing an empty summary.
  useEffect(() => {
    if (outcome?.status === "cancelled") {
      onClose()
      reset()
    }
  }, [outcome, onClose, reset])

  const handleClose = () => {
    // Closing mid-run cancels the in-flight batch rather than trapping the user.
    if (running) cancel()
    onClose()
    reset()
  }

  const handleRun = () => {
    mutate({ org, classroom, assignment, owners })
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      size="md"
      aria-labelledby={titleId}
    >
      <h3 id={titleId} className="flex items-center gap-2 text-lg font-bold">
        <FileArchive aria-hidden="true" className="size-5" />
        {t("submissions.downloadAll.title")}
      </h3>

      {error ? (
        <div className="mt-3 space-y-3">
          <Alert tone="error">
            {assemblyError
              ? t("submissions.downloadAll.assemblyError")
              : t("submissions.downloadAll.runError")}
          </Alert>
        </div>
      ) : summary ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm leading-6 text-base-content/70">
            <Trans
              i18nKey="submissions.downloadAll.summaryLead"
              values={{ total: summary.total }}
              components={{ b: <span className="font-semibold" /> }}
            />
          </p>
          {summary.fetched === 0 && (
            <Alert tone="warning">
              {t("submissions.downloadAll.nothingDownloaded")}
            </Alert>
          )}
          <ul className="space-y-1 text-sm">
            <li>
              {t(
                toDirectory
                  ? "submissions.downloadAll.summarySaved"
                  : "submissions.downloadAll.summaryDownloaded",
                { count: summary.fetched },
              )}
            </li>
            {summary.empty.length > 0 && (
              <li className="text-warning">
                {t("submissions.downloadAll.summaryEmpty", {
                  count: summary.empty.length,
                })}
              </li>
            )}
            {summary.failed.length > 0 && (
              <li className="text-error">
                {t("submissions.downloadAll.summaryFailed", {
                  count: summary.failed.length,
                })}
              </li>
            )}
          </ul>
          {summary.empty.length > 0 && (
            <OwnerListAlert
              owners={summary.empty}
              title={t("submissions.downloadAll.emptyTitle")}
              hint={t("submissions.downloadAll.emptyHint")}
            />
          )}
          {summary.failed.length > 0 && (
            <OwnerListAlert
              owners={summary.failed}
              title={t("submissions.downloadAll.failedTitle")}
              hint={t("submissions.downloadAll.failedHint")}
              showReason
            />
          )}
        </div>
      ) : running ? (
        <div className="mt-4 space-y-3">
          <p className="flex items-center gap-2 text-sm text-base-content/70">
            <Spinner size="xs" />
            {t("submissions.downloadAll.running", {
              done: progress?.done ?? 0,
              total: progress?.total ?? count,
            })}
          </p>
          <progress
            className="progress progress-primary w-full"
            value={progress?.done ?? 0}
            max={progress?.total ?? count}
          />
        </div>
      ) : (
        <div className="mt-3 space-y-2 text-sm leading-6 text-base-content/70">
          <p>
            <Trans
              i18nKey="submissions.downloadAll.confirmBody"
              values={{ count, name: assignmentName }}
              components={{
                b: <span className="font-semibold text-base-content" />,
              }}
            />
          </p>
          <p>{t("submissions.downloadAll.confirmHint")}</p>
          {count > BULK_DOWNLOAD_WARN_THRESHOLD && (
            <Alert tone="warning">
              {t("submissions.downloadAll.largeClassWarning", { count })}
            </Alert>
          )}
        </div>
      )}

      <div className="modal-action">
        {summary || error ? (
          <Button size="sm" onClick={handleClose}>
            {t("common.close")}
          </Button>
        ) : running ? (
          <Button variant="ghost" size="sm" onClick={handleClose}>
            {t("common.cancel")}
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={handleClose}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={count === 0}
              onClick={handleRun}
            >
              {t("submissions.downloadAll.confirmLabel", { count })}
            </Button>
          </>
        )}
      </div>
    </Modal>
  )
}

export default DownloadAllSubmissionsModal
