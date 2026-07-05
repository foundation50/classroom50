import { useEffect, useId, useRef } from "react"
import { useTranslation } from "react-i18next"
import { Check, Copy, X } from "lucide-react"

import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"

// A single copyable link row (read-only input + copy button).
const CopyLinkField = ({
  label,
  hint,
  url,
  ariaLabel,
  copyAriaLabel,
}: {
  label: string
  hint: string
  url: string
  ariaLabel: string
  copyAriaLabel: string
}) => {
  const { copied, copy } = useCopyToClipboard(url)
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs text-base-content/70">{hint}</span>
      <div className="join mt-1 w-full">
        <input
          type="text"
          readOnly
          value={url}
          aria-label={ariaLabel}
          onFocus={(event) => event.currentTarget.select()}
          className="input input-sm input-bordered join-item w-full font-mono text-xs"
        />
        <button
          type="button"
          className="btn btn-sm join-item"
          onClick={() => void copy()}
          aria-label={copyAriaLabel}
        >
          {copied ? (
            <>
              <Check aria-hidden="true" className="size-4 text-success" />
              {t("students.copied")}
            </>
          ) : (
            <>
              <Copy aria-hidden="true" className="size-4" />
              {t("students.copy")}
            </>
          )}
        </button>
      </div>
    </div>
  )
}

// Invite-links modal: only surfaces the shareable links a teacher copies to
// invite students (the classroom onboarding link and the native GitHub
// org-invite link). Enrollment side-actions (sync, resend) live on the roster
// table, not here.
const InviteLinksModal = ({
  open,
  org,
  classroom,
  onClose,
}: {
  open: boolean
  org: string
  classroom: string
  onClose: () => void
}) => {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()

  const onboardUrl = `${window.location.origin}/${org}/${classroom}/onboard`
  const inviteUrl = `https://github.com/orgs/${org}/invitation`

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      aria-labelledby={titleId}
      onCancel={onClose}
    >
      <div className="modal-box max-w-lg">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 id={titleId} className="text-lg font-bold">
              {t("students.inviteStudents")}
            </h3>
            <p className="mt-1 text-sm text-base-content/70">
              {t("students.inviteLinksHint")}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-square"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>

        <div className="mt-5 flex flex-col gap-5">
          <CopyLinkField
            label={t("students.onboardingLinkLabel")}
            hint={t("students.onboardingLinkHint")}
            url={onboardUrl}
            ariaLabel={t("students.onboardingLinkAria")}
            copyAriaLabel={t("students.copyOnboardingLinkAria")}
          />
          <CopyLinkField
            label={t("students.nativeInviteLabel")}
            hint={t("students.nativeInviteHint")}
            url={inviteUrl}
            ariaLabel={t("students.studentInviteLinkAria")}
            copyAriaLabel={t("students.copyInviteLinkAria")}
          />
        </div>

        <div className="modal-action">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>

      <form method="dialog" className="modal-backdrop">
        <button type="button" onClick={onClose}>
          {t("common.close")}
        </button>
      </form>
    </dialog>
  )
}

export default InviteLinksModal
