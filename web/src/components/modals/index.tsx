import { AlertIcon } from "@/components/ui/icons"
import { useEffect, useId, useRef, useState } from "react"
import { Trans, useTranslation } from "react-i18next"

import {
  Button,
  AnimatedAlert,
  Input,
  Modal,
  ModalIcon,
  MonoLtr,
  type ButtonVariant,
} from "@/components/ui"

type ConfirmModalProps = {
  open: boolean
  title: string
  description?: React.ReactNode
  // Only used when needsConfirm: the phrase the user must type to confirm.
  confirmText?: string
  confirmLabel?: string
  cancelLabel?: string
  dangerous?: boolean
  needsConfirm?: boolean
  // Blocks confirming (e.g. the caller's preview shows the action would touch
  // nobody) while still letting the user adjust the dialog's inputs or cancel.
  confirmDisabled?: boolean
  onConfirm: () => Promise<void>
  onClose: () => void
  // Extra body content rendered above the acknowledge prompt (e.g. an option
  // checkbox that adjusts what confirming will do).
  children?: React.ReactNode
}

// Primer-style ConfirmationDialog built on the shared Modal primitive
// (role="alertdialog", exactly two footer buttons: ghost Cancel left,
// error/warning/primary confirm right).
// `onClose` must be idempotent: a successful confirm and the dialog's native
// close event both fire it.
export function ConfirmModal({
  open,
  title,
  description,
  confirmText = "",
  confirmLabel,
  cancelLabel,
  dangerous = true,
  needsConfirm = true,
  confirmDisabled = false,
  onConfirm,
  onClose,
  children,
}: ConfirmModalProps) {
  const confirmInputRef = useRef<HTMLInputElement | null>(null)
  const { t } = useTranslation()
  const resolvedConfirmLabel =
    confirmLabel ?? t("components.confirmModal.confirm")
  const resolvedCancelLabel = cancelLabel ?? t("common.cancel")
  // Honor a caller's cancelLabel here too (the description copy may refer to it);
  // default to "No".
  const acknowledgeCancelLabel = cancelLabel ?? t("components.confirmModal.no")
  const [hasAcknowledged, setHasAcknowledged] = useState(false)
  const [typedText, setTypedText] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Synchronous re-entrancy latch. `isSubmitting` (React state) updates a tick
  // late and the button's disabled attr lags a render, so two same-tick clicks
  // could both pass the check and both run onConfirm(). This ref flips
  // synchronously, rejecting the second before it starts a duplicate write.
  const submittingRef = useRef(false)

  const matches = typedText === confirmText
  const canSubmit = !needsConfirm || matches
  const confirmHintId = useId()

  // The acknowledge → confirm step swaps content in the same open dialog, so the
  // input's `autoFocus` won't re-fire. Focus it explicitly so a keyboard/SR user
  // lands on the field they now have to fill in.
  useEffect(() => {
    if (hasAcknowledged) confirmInputRef.current?.focus()
  }, [hasAcknowledged])

  // Reset on open, never at close — see the close-animation note in ui/Modal.
  useEffect(() => {
    if (!open) return
    setHasAcknowledged(false)
    setTypedText("")
    setIsSubmitting(false)
    submittingRef.current = false
    setError(null)
  }, [open])

  const handleClose = (event?: React.SyntheticEvent | Event) => {
    event?.stopPropagation?.()

    if (isSubmitting) return

    onClose()
  }

  const handleSubmit = async () => {
    if (!canSubmit || submittingRef.current) return
    submittingRef.current = true

    setIsSubmitting(true)
    setError(null)

    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("components.confirmModal.genericError"),
      )
    } finally {
      submittingRef.current = false
      setIsSubmitting(false)
    }
  }

  const confirmButtonVariant: ButtonVariant = dangerous ? "error" : "primary"

  const acknowledgeButtonVariant: ButtonVariant = dangerous
    ? "error"
    : "warning"

  return (
    <Modal
      open={open}
      onClose={handleClose}
      role="alertdialog"
      closeDisabled={isSubmitting}
      title={title}
      subtitle={description}
      headerVisual={
        <ModalIcon tone={dangerous ? "error" : "warning"}>
          <AlertIcon className="size-4" aria-hidden="true" />
        </ModalIcon>
      }
      footer={
        !hasAcknowledged ? (
          <>
            <Button
              variant="ghost"
              disabled={isSubmitting}
              onClick={handleClose}
            >
              {acknowledgeCancelLabel}
            </Button>

            <Button
              variant={acknowledgeButtonVariant}
              disabled={isSubmitting || confirmDisabled}
              loading={isSubmitting && !needsConfirm}
              loadingLabel={t("common.working")}
              onClick={(event) => {
                event.stopPropagation()

                if (needsConfirm) {
                  setHasAcknowledged(true)
                  return
                }

                void handleSubmit()
              }}
            >
              {isSubmitting && !needsConfirm
                ? t("common.working")
                : needsConfirm
                  ? t("components.confirmModal.yesContinue")
                  : resolvedConfirmLabel}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              disabled={isSubmitting}
              onClick={handleClose}
            >
              {resolvedCancelLabel}
            </Button>

            <Button
              variant={confirmButtonVariant}
              disabled={!canSubmit || isSubmitting || confirmDisabled}
              loading={isSubmitting}
              loadingLabel={t("common.working")}
              onClick={() => void handleSubmit()}
            >
              {isSubmitting ? t("common.working") : resolvedConfirmLabel}
            </Button>
          </>
        )
      }
    >
      {!hasAcknowledged ? (
        <>
          {children}

          {dangerous ? (
            <div className="mt-6 rounded-box border border-base-300 bg-base-200/50 p-4 text-sm text-base-content/70">
              {t("components.confirmModal.dangerousPrompt")}
            </div>
          ) : null}

          <AnimatedAlert tone="error" show={!!error} className="mt-4 text-sm">
            {error}
          </AnimatedAlert>
        </>
      ) : (
        <div className="mt-6 space-y-3">
          <p id={confirmHintId} className="text-sm text-base-content/70">
            <Trans
              i18nKey="components.confirmModal.typeToConfirm"
              values={{ text: confirmText }}
              components={{
                text: <MonoLtr className="font-semibold text-base-content" />,
              }}
            />
          </p>

          <Input
            ref={confirmInputRef}
            type="text"
            className="font-mono"
            value={typedText}
            disabled={isSubmitting}
            autoFocus
            aria-label={t("components.confirmModal.typeAriaLabel", {
              text: confirmText,
            })}
            aria-describedby={confirmHintId}
            onChange={(event) => setTypedText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && matches) {
                void handleSubmit()
              }
            }}
          />

          <AnimatedAlert tone="error" show={!!error} className="text-sm">
            {error}
          </AnimatedAlert>
        </div>
      )}
    </Modal>
  )
}
