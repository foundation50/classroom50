import { useId } from "react"
import { Trans, useTranslation } from "react-i18next"
import { GitPullRequest } from "lucide-react"

import { Alert, Button, Modal, Spinner } from "@/components/ui"
import useOpenAllFeedbackPrs from "@/hooks/mutations/useOpenAllFeedbackPrs"
import type { AssignmentMode } from "@/types/classroom"

// Bulk "Open all Feedback PRs" for an assignment (issue #347). Three states in
// one dialog: confirm (repo count), running (live X/N progress, dismissal
// blocked), and summary (opened / already had one / failed). Idempotent — a
// repo that already has a PR is reported as "already had one", never
// duplicated — so re-running is safe.
export function OpenAllFeedbackPrsModal({
  open,
  onClose,
  org,
  assignmentName,
  mode,
  repos,
}: {
  open: boolean
  onClose: () => void
  org: string
  assignmentName: string
  mode: AssignmentMode
  // Every existing assignment repo NAME (individual + group), enumerated by the
  // page from the org repo list.
  repos: string[]
}) {
  const { t } = useTranslation()
  const titleId = useId()
  const {
    mutate,
    isPending,
    data: summary,
    progress,
    reset,
  } = useOpenAllFeedbackPrs()

  const count = repos.length
  const running = isPending
  const closeDisabled = running

  const handleClose = () => {
    if (closeDisabled) return
    onClose()
    // Clear the prior run so reopening starts at the confirm state.
    reset()
  }

  const handleRun = () => {
    mutate({ org, repos, mode })
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      size="md"
      closeDisabled={closeDisabled}
      aria-labelledby={titleId}
    >
      <h3 id={titleId} className="flex items-center gap-2 text-lg font-bold">
        <GitPullRequest aria-hidden="true" className="size-5" />
        {t("submissions.openAllPrs.title")}
      </h3>

      {/* Summary — the run finished. */}
      {summary ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm leading-6 text-base-content/70">
            <Trans
              i18nKey="submissions.openAllPrs.summaryLead"
              values={{ total: summary.total }}
              components={{ b: <span className="font-semibold" /> }}
            />
          </p>
          <ul className="space-y-1 text-sm">
            <li>
              {t("submissions.openAllPrs.summaryOpened", {
                count: summary.created,
              })}
            </li>
            <li>
              {t("submissions.openAllPrs.summaryExisted", {
                count: summary.existed,
              })}
            </li>
            {summary.unsupported.length > 0 && (
              <li>
                {t("submissions.openAllPrs.summaryUnsupported", {
                  count: summary.unsupported.length,
                })}
              </li>
            )}
            {summary.failed.length > 0 && (
              <li className="text-error">
                {t("submissions.openAllPrs.summaryFailed", {
                  count: summary.failed.length,
                })}
              </li>
            )}
          </ul>
          {summary.failed.length > 0 && (
            <Alert tone="warning">
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {t("submissions.openAllPrs.failedTitle")}
                </p>
                <ul className="max-h-40 overflow-y-auto text-xs">
                  {summary.failed.map((f) => (
                    <li key={f.repo} className="font-mono">
                      {f.repo}
                      {f.reason ? ` — ${f.reason}` : ""}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-base-content/70">
                  {t("submissions.openAllPrs.failedHint")}
                </p>
              </div>
            </Alert>
          )}
        </div>
      ) : running ? (
        /* Running — live progress. */
        <div className="mt-4 space-y-3">
          <p className="flex items-center gap-2 text-sm text-base-content/70">
            <Spinner size="xs" />
            {t("submissions.openAllPrs.running", {
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
        /* Confirm. */
        <div className="mt-3 space-y-2 text-sm leading-6 text-base-content/70">
          <p>
            <Trans
              i18nKey="submissions.openAllPrs.confirmBody"
              values={{ count, name: assignmentName }}
              components={{
                b: <span className="font-semibold text-base-content" />,
              }}
            />
          </p>
          <p>{t("submissions.openAllPrs.confirmHint")}</p>
        </div>
      )}

      <div className="modal-action">
        {summary ? (
          <Button size="sm" onClick={handleClose}>
            {t("common.close")}
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={running}
              onClick={handleClose}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={running}
              loadingLabel={t("submissions.openAllPrs.running", {
                done: progress?.done ?? 0,
                total: progress?.total ?? count,
              })}
              disabled={running || count === 0}
              onClick={handleRun}
            >
              {t("submissions.openAllPrs.confirmLabel", { count })}
            </Button>
          </>
        )}
      </div>
    </Modal>
  )
}

export default OpenAllFeedbackPrsModal
