import { useTranslation } from "react-i18next"
import { AlertIcon } from "@/components/ui/icons"

import { Alert, Button, Modal, ModalIcon } from "@/components/ui"

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
  const { t } = useTranslation()

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={saving}
      size="lg"
      role="alertdialog"
      title={t("assignmentSettings.provisioningConfirm.title")}
      headerVisual={
        <ModalIcon tone="warning">
          <AlertIcon className="size-4" aria-hidden="true" />
        </ModalIcon>
      }
      footer={
        <>
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
        </>
      }
    >
      <Alert tone="warning" className="mt-4 text-sm">
        {t("assignmentSettings.provisioningConfirm.body", {
          count: acceptedCount,
        })}
      </Alert>
    </Modal>
  )
}

export default ProvisioningChangeConfirmModal
