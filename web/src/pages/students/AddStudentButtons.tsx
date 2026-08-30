import { useTranslation } from "react-i18next"
import {
  ChevronDownIcon,
  PencilIcon,
  PlusIcon,
  ShareAndroidIcon,
  UploadIcon,
} from "@/components/ui/icons"

import { Button, DropdownMenu, closeDropdownMenu } from "@/components/ui"
import type { AddStudentActions } from "@/pages/students/RosterBulkActionsBar"

// The roster's add-students trigger cluster — Share (classroom links), Edit
// (batch edit mode, owner-only and toolbar-only), and a split Upload roster
// primary button whose chevron menu holds Add member — rendered by both
// the toolbar and the empty state so the labels and order can't drift.
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
      <div className="join">
        <Button
          variant="primary"
          size="sm"
          disabled={disabled}
          className="join-item"
          onClick={addActions.onUploadRoster}
        >
          <UploadIcon aria-hidden="true" className="size-4" />
          {t("students.uploadTitle")}
        </Button>
        {/* Not a join-item itself: see NewClassroomButton in ClassesPage.tsx. */}
        <div className="dropdown dropdown-end -ms-px">
          <Button
            variant="primary"
            size="sm"
            tabIndex={0}
            disabled={disabled}
            className="join-item h-full border-s border-primary-content/20 px-2"
            aria-label={t("students.addMoreOptions")}
          >
            <ChevronDownIcon aria-hidden="true" className="size-4" />
          </Button>
          <DropdownMenu className="w-max">
            <li>
              <button
                type="button"
                onClick={() => {
                  closeDropdownMenu()
                  addActions.onAddStudent()
                }}
              >
                <PlusIcon aria-hidden="true" className="size-4" />
                {t("students.addTitle")}
              </button>
            </li>
          </DropdownMenu>
        </div>
      </div>
    </>
  )
}

export default AddStudentButtons
