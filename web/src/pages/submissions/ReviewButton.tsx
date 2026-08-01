import { MessageCircle } from "lucide-react"
import { useId, useRef, useState } from "react"
import { Trans, useTranslation } from "react-i18next"

import { Button, Modal, MonoLtr } from "@/components/ui"
import { useToast } from "@/context/notifications/NotificationProvider"
import useGetFeedbackPr from "@/hooks/useGetFeedbackPr"
import useRepairFeedbackPr from "@/hooks/mutations/useRepairFeedbackPr"
import type { AssignmentMode } from "@/types/classroom"

// Review action: links to the open Feedback PR (opened at accept time, or by
// the autograde runner) when one exists; when none does, offers a teacher-side
// Repair that re-runs the same idempotent ensure flow with the teacher's token
// (issue #347 — recovers a PR a student's accept-time attempt failed to open).
// The PR is the source of truth. The /pulls lookup is deferred until Review is
// clicked (an eager per-row query would fan out to one request per repo on
// mount); on click we refetch.
export const ReviewButton = ({
  org,
  repo,
  mode,
  noRepo = false,
}: {
  org: string
  repo: string
  mode: AssignmentMode
  // No assignment repo exists yet (never-accepted non-submitter): there can be
  // no Feedback PR to review or repair, so render the button disabled.
  noRepo?: boolean
}) => {
  const { t } = useTranslation()
  const { notify } = useToast()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()
  const [resolving, setResolving] = useState(false)
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
        setErrorMsg(error instanceof Error ? error.message : String(error))
        dialogRef.current?.showModal()
      } else if (pr) {
        window.open(pr.html_url, "_blank", "noopener,noreferrer")
      } else {
        setErrorMsg(null)
        dialogRef.current?.showModal()
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
            notify({
              tone: "success",
              durationMs: 5000,
              message: result.created
                ? t("submissions.repairPr.created", { repo })
                : t("submissions.repairPr.alreadyExists", { repo }),
            })
            dialogRef.current?.close()
            // The PR now exists (created or adopted): resolve and open it.
            const { data: pr } = await refetch()
            if (pr) window.open(pr.html_url, "_blank", "noopener,noreferrer")
            return
          }
          setErrorMsg(repairReasonMessage(result))
        },
        onError: (err) => {
          setErrorMsg(err instanceof Error ? err.message : String(err))
        },
      },
    )
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        shape="square"
        className="text-base-content/70 disabled:opacity-60"
        disabled={noRepo || resolving}
        loading={resolving}
        loadingLabel={t("submissions.table.review")}
        onClick={handleReview}
        aria-label={t("submissions.table.reviewAria")}
        title={
          noRepo
            ? t("submissions.table.reviewNoRepo")
            : t("submissions.table.review")
        }
      >
        {!resolving && <MessageCircle aria-hidden="true" className="size-4" />}
      </Button>
      <Modal
        dialogRef={dialogRef}
        size="md"
        hideCloseButton
        aria-labelledby={titleId}
      >
        {errorMsg ? (
          <>
            <h3 id={titleId} className="text-lg font-bold">
              {t("submissions.reviewModal.errorTitle")}
            </h3>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-base-content/70">
              {errorMsg}
            </p>
          </>
        ) : (
          <>
            <h3 id={titleId} className="text-lg font-bold">
              {t("submissions.reviewModal.emptyTitle")}
            </h3>
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
        <div className="modal-action">
          <a
            className="btn btn-ghost btn-sm"
            href={`https://github.com/${org}/${repo}/pulls`}
            target="_blank"
            rel="noreferrer"
          >
            {t("submissions.reviewModal.openRepoPrs")}
          </a>
          {!errorMsg && (
            <Button
              size="sm"
              loading={repair.isPending}
              loadingLabel={t("submissions.repairPr.repairing")}
              onClick={handleRepair}
            >
              {t("submissions.repairPr.repair")}
            </Button>
          )}
          <Button
            variant={errorMsg ? undefined : "ghost"}
            size="sm"
            disabled={repair.isPending}
            onClick={() => dialogRef.current?.close()}
          >
            {t("common.close")}
          </Button>
        </div>
      </Modal>
    </>
  )
}

export default ReviewButton
