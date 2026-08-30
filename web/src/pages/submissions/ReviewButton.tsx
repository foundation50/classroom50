import { CodeReviewIcon } from "@/components/ui/icons"
import { useState } from "react"
import { Trans, useTranslation } from "react-i18next"

import { Button, Modal, MonoLtr } from "@/components/ui"
import { useToast } from "@/context/notifications/NotificationProvider"
import useGetFeedbackPr from "@/hooks/useGetFeedbackPr"
import useRepairFeedbackPr from "@/hooks/mutations/useRepairFeedbackPr"
import { ActionListRow } from "@/pages/submissions/actionLayout"
import { errorText } from "@/types/localizedMessage"
import type { AssignmentMode } from "@/types/classroom"

// The Feedback-PR action: links to the open Feedback PR (opened at accept
// time, or by the autograde runner) when one exists; when none does, offers a
// teacher-side Repair that re-runs the same idempotent ensure flow with the
// teacher's token (issue #347 — recovers a PR a student's accept-time attempt
// failed to open). The PR is the source of truth. The /pulls lookup is
// deferred until the trigger is clicked (an eager per-row query would fan out
// to one request per repo on mount); on click we refetch.
//
// The trigger rendering is a render prop so the hub's Review row and the
// table's per-row icon (issue #741) share one resolve/repair flow.
export const FeedbackPrAction = ({
  org,
  repo,
  mode,
  noRepo = false,
  trigger,
}: {
  org: string
  repo: string
  mode: AssignmentMode
  // No assignment repo exists yet (never-accepted non-submitter): there can be
  // no Feedback PR to review or repair, so the trigger renders disabled.
  noRepo?: boolean
  trigger: (props: {
    onClick: () => void
    resolving: boolean
  }) => React.ReactNode
}) => {
  const { t } = useTranslation()
  const { notify } = useToast()
  const [resolving, setResolving] = useState(false)
  // The empty/error modal is mounted on demand (controlled `open`), not per
  // trigger: the table renders one action per row, and a hidden <dialog> per
  // row would be dead DOM weight on large rosters.
  const [modalOpen, setModalOpen] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // enabled: false — driven by refetch() on click, never on mount.
  const { refetch } = useGetFeedbackPr(org, repo, false)
  const repair = useRepairFeedbackPr()

  const handleReview = async () => {
    if (noRepo) return
    setResolving(true)
    try {
      // getOpenPullRequests maps 404 -> [], so a non-404 failure surfaces as
      // `error`; show it rather than the misleading "no PR yet" message.
      const { data: pr, error } = await refetch()
      if (error) {
        setErrorMsg(errorText(t, error))
        setModalOpen(true)
      } else if (pr) {
        window.open(pr.html_url, "_blank", "noopener,noreferrer")
      } else {
        setErrorMsg(null)
        setModalOpen(true)
      }
    } finally {
      setResolving(false)
    }
  }

  // Map the domain's failure to friendly copy. Structural verdicts
  // (`no-baseline` / `repo-not-found` — no Feedback PR is possible for this
  // repo) and the blocked `base-mismatch` (only an org admin can fix it) are
  // terminal messages shown in the modal, not retryable toasts. Everything else
  // is a transient failure the teacher can retry.
  const repairReasonMessage = (
    result: Extract<
      ReturnType<typeof useRepairFeedbackPr>["data"],
      { ok: false }
    >,
  ) => {
    if ("unsupported" in result) {
      return result.reason === "no-baseline"
        ? t("submissions.repairPr.noBaseline")
        : t("submissions.repairPr.repoNotFound", { repo })
    }
    if (result.code === "base-mismatch") {
      return t("submissions.repairPr.baseMismatch")
    }
    return t("submissions.repairPr.failed", { reason: result.reason })
  }

  const handleRepair = () => {
    repair.mutate(
      { org, repo, mode },
      {
        onSuccess: async (result) => {
          if (result.ok) {
            // Kept as a toast: the repaired PR opens in another tab and this
            // dialog closes, so nothing on the page evidences the outcome.
            notify({
              tone: "success",
              durationMs: 5000,
              message: result.created
                ? t("submissions.repairPr.created", { repo })
                : t("submissions.repairPr.alreadyExists", { repo }),
            })
            setModalOpen(false)
            // The PR now exists (created or adopted): resolve and open it.
            const { data: pr } = await refetch()
            if (pr) window.open(pr.html_url, "_blank", "noopener,noreferrer")
            return
          }
          setErrorMsg(repairReasonMessage(result))
        },
        onError: (err) => {
          setErrorMsg(errorText(t, err))
        },
      },
    )
  }

  return (
    <>
      {trigger({ onClick: () => void handleReview(), resolving })}
      {modalOpen && (
        <Modal
          open
          onClose={() => setModalOpen(false)}
          size="md"
          title={
            errorMsg
              ? t("submissions.reviewModal.errorTitle")
              : t("submissions.reviewModal.emptyTitle")
          }
          footer={
            <>
              <Button
                as="a"
                variant="ghost"
                size="sm"
                href={`https://github.com/${org}/${repo}/pulls`}
                target="_blank"
                rel="noreferrer"
              >
                {t("submissions.reviewModal.openRepoPrs")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={repair.isPending}
                onClick={() => setModalOpen(false)}
              >
                {t("common.close")}
              </Button>
              {!errorMsg && (
                <Button
                  variant="primary"
                  size="sm"
                  loading={repair.isPending}
                  loadingLabel={t("submissions.repairPr.repairing")}
                  onClick={handleRepair}
                >
                  {t("submissions.repairPr.repair")}
                </Button>
              )}
            </>
          }
        >
          {errorMsg ? (
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-base-content/70">
              {errorMsg}
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm leading-6 text-base-content/70">
                <Trans
                  i18nKey="submissions.reviewModal.emptyBody"
                  values={{ repo }}
                  components={{ repo: <MonoLtr /> }}
                />
              </p>
              <p className="mt-3 text-sm leading-6 text-base-content/70">
                {t("submissions.repairPr.hint")}
              </p>
            </>
          )}
        </Modal>
      )}
    </>
  )
}

// The submission hub's Review row: the labeled-list rendering of the shared
// Feedback-PR action.
export const ReviewButton = ({
  org,
  repo,
  mode,
  noRepo = false,
}: {
  org: string
  repo: string
  mode: AssignmentMode
  noRepo?: boolean
}) => {
  const { t } = useTranslation()
  return (
    <FeedbackPrAction
      org={org}
      repo={repo}
      mode={mode}
      noRepo={noRepo}
      trigger={({ onClick, resolving }) => (
        <ActionListRow
          icon={CodeReviewIcon}
          title={t("submissions.table.review")}
          description={t("submissions.manageModal.reviewDescription")}
          onClick={onClick}
          disabled={noRepo}
          loading={resolving}
          loadingLabel={t("submissions.table.review")}
          ariaLabel={t("submissions.table.reviewAria")}
        />
      )}
    />
  )
}

// Per-row Feedback-PR shortcut (issue #741): one click from the submissions
// table to the student's Feedback PR, matching the old classroom's direct
// link. A never-accepted student (`noRepo`) renders an inert dimmed icon and
// deliberately skips the action's hook/modal machinery, like RegradeButton.
export const FeedbackPrIconButton = ({
  org,
  repo,
  mode,
  hasRepo,
}: {
  org: string
  repo: string
  mode: AssignmentMode
  hasRepo: boolean
}) => {
  const { t } = useTranslation()
  if (!hasRepo) {
    // Inert anchor rather than a disabled button, mirroring ActionIconLink's
    // empty branch: daisyUI suppresses the explanatory tooltip on :disabled
    // buttons.
    return (
      <Button
        as="a"
        variant="ghost"
        size="sm"
        shape="square"
        className="cursor-not-allowed text-base-content/30 hover:bg-transparent"
        disabled
        aria-label={t("submissions.table.openFeedbackPrLabel", { repo })}
        title={t("submissions.table.noRepoYetTitle")}
        onClick={(event) => event.stopPropagation()}
      >
        <CodeReviewIcon className="size-4 opacity-50" />
      </Button>
    )
  }
  return (
    <FeedbackPrAction
      org={org}
      repo={repo}
      mode={mode}
      trigger={({ onClick, resolving }) => (
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          className="text-base-content/70"
          loading={resolving}
          loadingLabel={t("submissions.table.viewFeedbackPr")}
          aria-label={t("submissions.table.openFeedbackPrLabel", { repo })}
          title={t("submissions.table.viewFeedbackPr")}
          // The row behind this button opens the manage modal on click; never
          // let this click double as a row click.
          onClick={(event) => {
            event.stopPropagation()
            onClick()
          }}
        >
          {!resolving && (
            <CodeReviewIcon aria-hidden="true" className="size-4" />
          )}
        </Button>
      )}
    />
  )
}

export default ReviewButton
