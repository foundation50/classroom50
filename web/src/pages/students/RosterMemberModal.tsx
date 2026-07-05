import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Send, Trash, X } from "lucide-react"

import { useMutation } from "@tanstack/react-query"

import MemberDetailHeader from "@/components/memberList/MemberDetailHeader"
import EditStudentForm from "@/pages/students/EditStudentForm"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { unenrollStudent } from "@/api/mutations/students"
import type { StudentCsvRow } from "@/api/mutations/students"
import { resendOrgInvitation, getErrorMessage } from "@/hooks/github/mutations"
import { rosterRowToMemberRow } from "@/util/memberRow"
import { rowToStudent, type TeamRosterRow } from "@/util/teamRoster"

// Roster-owned detail modal (single native <dialog>), opened by clicking a
// roster row. Shares the identity header with the Org Members modal; everything
// below is classroom-scoped and gated by row.state:
//   enrolled    -> edit metadata + unenroll
//   pending     -> resend invite + unenroll (cancels the invite); no edit
//   not_in_org  -> edit metadata + unenroll (drops the CSV row); no resend
//
// The modal performs the writes but hands results back to the parent (which
// owns the roster/invite caches and the per-row warnings map), mirroring the
// pre-refactor inline actions.
const RosterMemberModal = ({
  open,
  org,
  classroom,
  row,
  onClose,
  onSaved,
  onUnenrolled,
  onResent,
  onError,
}: {
  open: boolean
  org: string
  classroom: string
  // Nullable so the <dialog> can stay mounted across open/close.
  row: TeamRosterRow | null
  onClose: () => void
  onSaved: (rowKey: string, updated: StudentCsvRow) => void
  onUnenrolled: (rowKey: string, teamWarning?: string) => void
  onResent: (rowKey: string) => void
  onError: (rowKey: string, message: string) => void
}) => {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()
  const [confirmingUnenroll, setConfirmingUnenroll] = useState(false)
  const [working, setWorking] = useState(false)
  const [resending, setResending] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const unenrollMutation = useMutation({
    mutationFn: (student: ReturnType<typeof rowToStudent>) =>
      unenrollStudent(client, { org, classroom, student }),
  })

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  const busy = working || submitting

  const handleClose = () => {
    if (busy) return
    setConfirmingUnenroll(false)
    onClose()
  }

  if (!row) {
    // Keep the dialog mounted (target for the open/close effect) with no body.
    return <dialog ref={dialogRef} className="modal" aria-hidden />
  }

  const student = rowToStudent(row)
  const canEdit = row.state !== "pending"
  const canResend = row.state === "pending" && Boolean(row.github_id)

  const handleResend = async () => {
    if (resending) return
    const inviteeId = Number(row.github_id)
    if (!Number.isFinite(inviteeId) || inviteeId <= 0 || !row.username) {
      onError(
        row.key,
        t("students.resendMissingId", { username: row.username || row.email }),
      )
      return
    }
    setResending(true)
    try {
      await resendOrgInvitation(client, {
        org,
        username: row.username,
        inviteeId,
        invitationId: row.invitation_id,
      })
      onResent(row.key)
      onClose()
    } catch (err) {
      onError(
        row.key,
        t("students.resendFailed", {
          username: row.username || row.email,
          error: getErrorMessage(err),
        }),
      )
    } finally {
      setResending(false)
    }
  }

  const handleUnenroll = async () => {
    if (working) return
    setWorking(true)
    try {
      const result = await unenrollMutation.mutateAsync(student)
      onUnenrolled(row.key, result.teamWarning)
      onClose()
    } catch (err) {
      onError(
        row.key,
        err instanceof Error ? err.message : t("students.somethingWentWrong"),
      )
    } finally {
      setWorking(false)
      setConfirmingUnenroll(false)
    }
  }

  const label = row.username || row.email

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        if (busy) {
          event.preventDefault()
          return
        }
        handleClose()
      }}
    >
      <div className="modal-box max-w-lg p-0">
        <div className="flex items-start justify-between gap-4 border-b border-base-300 px-6 py-4">
          <h2 id={titleId} className="text-lg font-bold">
            {t("students.detailTitle")}
          </h2>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-square"
            onClick={handleClose}
            disabled={busy}
            aria-label={t("common.close")}
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-6 py-5">
          <MemberDetailHeader row={rosterRowToMemberRow(row)} org={org} />

          <div className="flex flex-wrap items-center gap-2">
            {row.state === "enrolled" ? (
              <span className="badge badge-sm badge-success badge-soft">
                {t("students.statusEnrolled")}
              </span>
            ) : null}
            {row.state === "pending" ? (
              <span className="badge badge-sm badge-warning badge-soft">
                {t("students.statusPending")}
              </span>
            ) : null}
            {row.state === "not_in_org" ? (
              <span className="badge badge-sm badge-ghost badge-soft">
                {t("students.statusNotInOrg")}
              </span>
            ) : null}
            {row.section.trim() ? (
              <span className="badge badge-sm badge-ghost">
                {row.section.trim()}
              </span>
            ) : null}
          </div>

          {canEdit ? (
            <EditStudentForm
              org={org}
              classroom={classroom}
              student={student}
              resetSignal={`${row.key}:${open}`}
              onCancel={handleClose}
              onSubmittingChange={setSubmitting}
              onSaved={(updated) => onSaved(row.key, updated)}
            />
          ) : (
            <p className="text-sm text-base-content/70">
              {t("students.pendingNoEdit")}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-base-300 pt-4">
            {canResend ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled={resending || working}
                onClick={() => void handleResend()}
              >
                {resending ? (
                  <span
                    className="loading loading-spinner loading-xs"
                    aria-hidden="true"
                  />
                ) : (
                  <>
                    <Send aria-hidden="true" className="size-4" />
                    {t("students.resend")}
                  </>
                )}
              </button>
            ) : null}

            {confirmingUnenroll ? (
              <div className="flex w-full flex-col gap-3 rounded-box border border-error/30 bg-error/5 p-4 text-sm">
                <p className="text-base-content/80">
                  {t("students.unenrollBodyPrefix")}{" "}
                  <span className="font-semibold text-base-content">
                    {label}
                  </span>{" "}
                  {t("students.unenrollBodyFrom")}{" "}
                  <span className="font-semibold text-base-content">{org}</span>{" "}
                  {t("students.unenrollBodySuffix", { classroom })}
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={working}
                    onClick={() => setConfirmingUnenroll(false)}
                  >
                    {t("students.keepStudent")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-error btn-sm"
                    disabled={working}
                    onClick={() => void handleUnenroll()}
                  >
                    {working ? (
                      <>
                        <span
                          className="loading loading-spinner loading-xs"
                          aria-hidden="true"
                        />
                        {t("common.working")}
                      </>
                    ) : (
                      t("students.unenrollStudent")
                    )}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-error btn-outline btn-sm"
                disabled={busy}
                onClick={() => setConfirmingUnenroll(true)}
              >
                <Trash aria-hidden="true" className="size-4" />
                {t("students.unenrollStudent")}
              </button>
            )}
          </div>
        </div>
      </div>

      <form method="dialog" className="modal-backdrop">
        <button type="button" onClick={handleClose} disabled={busy}>
          {t("common.close")}
        </button>
      </form>
    </dialog>
  )
}

export default RosterMemberModal
