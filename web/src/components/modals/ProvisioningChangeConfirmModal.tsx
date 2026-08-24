import { useId } from "react"
import { useTranslation } from "react-i18next"
import { AlertIcon } from "@primer/octicons-react"

import { Alert, Button, Modal } from "@/components/ui"

type ProvisioningChangeConfirmModalProps = {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  // How many student repositories already exist for this assignment. Drives the
  // pluralized warning copy; the modal is only opened when this is > 0.
  acceptedCount: number
  saving?: boolean
}

// Confirm changing a provisioning-class setting (repository source, built-in
// autograder, or grading mode) after students have already accepted. The
// setting is editable now, but existing repos are never retrofitted, so the
// teacher must acknowledge that the change only affects future accepts and that
// reconciling the existing repos is on them. Mirrors the CLI's non-blocking
// warning; here it's a blocking confirm because the web edit is a single click.
export function ProvisioningChangeConfirmModal({
  open,
  onClose,
  onConfirm,
  acceptedCount,
  saving = false,
}: ProvisioningChangeConfirmModalProps) {
  const titleId = useId()
  const { t } = useTranslation()

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={saving}
      size="lg"
      aria-labelledby={titleId}
    >
      <div className="flex items-start gap-4">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-box bg-warning/10 text-warning">
          <AlertIcon className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-lg font-bold">
            {t("assignmentSettings.provisioningConfirm.title")}
          </h3>
          <Alert tone="warning" className="mt-3 text-sm">
            {t("assignmentSettings.provisioningConfirm.body", {
              count: acceptedCount,
            })}
          </Alert>
        </div>
      </div>

      <div className="modal-action">
        <Button variant="ghost" disabled={saving} onClick={onClose}>
          {t("assignmentSettings.provisioningConfirm.cancel")}
        </Button>
        <Button
          variant="warning"
          loading={saving}
          disabled={saving}
          onClick={onConfirm}
        >
          {t("assignmentSettings.provisioningConfirm.confirm")}
        </Button>
      </div>
    </Modal>
  )
}

export default ProvisioningChangeConfirmModal
