import { useTranslation } from "react-i18next"
import { AlertIcon } from "@/components/ui/icons"

import { Alert, Button, Modal, ModalIcon } from "@/components/ui"
import type { EditImpact } from "@/domain/assignments"

type EditImpactConfirmModalProps = {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  // What the save changes for students, from editImpactSummary. The modal is
  // only opened when this is non-empty.
  impact: EditImpact[]
  // How many student repositories already exist for this assignment. Drives
  // the pluralized "future accepts only" intro shown with provisioning items.
  acceptedCount: number
  saving?: boolean
}

// Confirm an edit that changes what students can do or see. Two classes of
// change are listed: access changes (lock/unlock) take effect for every student
// the moment the save lands; provisioning changes (repository source, built-in
// autograder, grading mode, student repository access, visibility) only affect
// repositories accepted from now on, since existing repos are never retrofitted.
// Mirrors the CLI's non-blocking warnings; here it's a blocking confirm because
// the web edit is a single click.
export function EditImpactConfirmModal({
  open,
  onClose,
  onConfirm,
  impact,
  acceptedCount,
  saving = false,
}: EditImpactConfirmModalProps) {
  const { t } = useTranslation()
  const access = impact.filter((item) => item.kind !== "provisioning")
  const provisioning = impact.filter((item) => item.kind === "provisioning")
  // An unlock alone re-opens the assignment; nothing is lost, so no warning.
  const unlockOnly = impact.every((item) => item.kind === "unlock")

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={saving}
      size="lg"
      role="alertdialog"
      title={t("assignmentSettings.editConfirm.title")}
      headerVisual={
        <ModalIcon tone={unlockOnly ? "primary" : "warning"}>
          <AlertIcon className="size-4" aria-hidden="true" />
        </ModalIcon>
      }
      footer={
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {t("assignmentSettings.editConfirm.cancel")}
          </Button>
          <Button
            variant={unlockOnly ? "primary" : "warning"}
            loading={saving}
            disabled={saving}
            onClick={onConfirm}
          >
            {t("assignmentSettings.editConfirm.confirm")}
          </Button>
        </>
      }
    >
      <div className="mt-4 flex flex-col gap-3 text-sm">
        {access.length > 0 ? (
          <Alert tone={unlockOnly ? "info" : "warning"} icon={null}>
            <ItemList
              items={access.map((item) => ({
                key: item.kind,
                text: t(`assignmentSettings.editConfirm.access.${item.kind}`),
              }))}
            />
          </Alert>
        ) : null}
        {provisioning.length > 0 ? (
          <Alert tone="warning" icon={null}>
            <div className="flex flex-col gap-2">
              <p>
                {t("assignmentSettings.editConfirm.provisioningIntro", {
                  count: acceptedCount,
                })}
              </p>
              <ItemList
                items={provisioning.flatMap((item) =>
                  item.kind === "provisioning"
                    ? [
                        {
                          key: item.field,
                          text: t(
                            `assignmentSettings.editConfirm.provisioning.${item.field}`,
                          ),
                        },
                      ]
                    : [],
                )}
              />
            </div>
          </Alert>
        ) : null}
      </div>
    </Modal>
  )
}

// A single item reads as a sentence; two or more become a bullet list.
function ItemList({ items }: { items: { key: string; text: string }[] }) {
  if (items.length === 1) return <p>{items[0].text}</p>
  return (
    <ul className="list-disc ps-5">
      {items.map((item) => (
        <li key={item.key}>{item.text}</li>
      ))}
    </ul>
  )
}

export default EditImpactConfirmModal
