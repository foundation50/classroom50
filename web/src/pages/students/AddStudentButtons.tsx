import { useTranslation } from "react-i18next"
import { PlusIcon, ShareAndroidIcon, UploadIcon } from "@/components/ui/icons"

import { Button } from "@/components/ui"
import type { AddStudentActions } from "@/pages/students/RosterBulkActionsBar"

// The roster's add-students trigger triplet — Share (classroom links),
// icon-only Upload, and Add member as the primary action — rendered by both
// the toolbar and the empty state so the labels and order can't drift.
export function AddStudentButtons({
  addActions,
  disabled = false,
}: {
  addActions: AddStudentActions
  // Frozen while a sync rewrites the roster these actions feed.
  disabled?: boolean
}) {
  const { t } = useTranslation()
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        title={t("students.shareLinksTitle")}
        onClick={addActions.onInviteLinks}
      >
        <ShareAndroidIcon aria-hidden="true" className="size-4" />
        {t("students.share")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        shape="square"
        disabled={disabled}
        aria-label={t("students.uploadTitle")}
        title={t("students.uploadTitle")}
        onClick={addActions.onUploadRoster}
      >
        <UploadIcon aria-hidden="true" className="size-4" />
      </Button>
      <Button
        variant="primary"
        size="sm"
        disabled={disabled}
        onClick={addActions.onAddStudent}
      >
        <PlusIcon aria-hidden="true" className="size-4" />
        {t("students.addTitle")}
      </Button>
    </>
  )
}

export default AddStudentButtons
