import { useTranslation } from "react-i18next"
import {
  PencilIcon,
  PlusIcon,
  ShareAndroidIcon,
  UploadIcon,
} from "@/components/ui/icons"

import { Button } from "@/components/ui"
import type { AddStudentActions } from "@/pages/students/RosterBulkActionsBar"

// The roster's add-students trigger cluster — Share (classroom links), Edit
// (batch edit mode, owner-only and toolbar-only), icon-only Upload, and Add
// member as the primary action — rendered by both the toolbar and the empty
// state so the labels and order can't drift.
export function AddStudentButtons({
  addActions,
  onEditRoster,
  disabled = false,
}: {
  addActions: AddStudentActions
  // Enters batch Edit mode; absent (non-owner, or the empty state where
  // there's nothing to edit) hides the button.
  onEditRoster?: () => void
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
      {onEditRoster ? (
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={onEditRoster}
        >
          <PencilIcon aria-hidden="true" className="size-4" />
          {t("students.editRoster.button")}
        </Button>
      ) : null}
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
