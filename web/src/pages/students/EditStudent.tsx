import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import EditStudentForm from "@/pages/students/EditStudentForm"
import type { Student } from "@/types/classroom"
import type { StudentCsvRow } from "@/api/mutations/students"

type EditStudentProps = {
  org: string
  classroom: string
  student: Student
  open: boolean
  onClose: () => void
  onSaved: (updated: StudentCsvRow) => void
}

// Standalone dialog shell around EditStudentForm, driven by the `open` prop.
// The form itself (fields, validation, save) lives in EditStudentForm so the
// roster detail modal can embed it without nesting a second <dialog showModal>.
const EditStudent = ({
  org,
  classroom,
  student,
  open,
  onClose,
  onSaved,
}: EditStudentProps) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()
  const { t } = useTranslation()
  const [submitting, setSubmitting] = useState(false)

  const displayHandle = student.username || student.email

  const closeDialog = () => {
    if (submitting) return
    onClose()
  }

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
      onClose={closeDialog}
      onCancel={(event) => {
        if (submitting) {
          event.preventDefault()
          return
        }
        closeDialog()
      }}
    >
      <div className="modal-box max-w-lg">
        <h3 id={titleId} className="text-lg font-bold">
          {t("students.editTitle")}
        </h3>
        <p className="mt-1 text-sm text-base-content/70">
          {t("students.editingPrefix")}{" "}
          <span className="font-semibold text-base-content">
            {displayHandle ? `@${displayHandle}` : t("students.thisStudent")}
          </span>
          {t("students.editingSuffix")}
        </p>

        <EditStudentForm
          org={org}
          classroom={classroom}
          student={student}
          resetSignal={open}
          onCancel={closeDialog}
          onSubmittingChange={setSubmitting}
          onSaved={(updated) => {
            onSaved(updated)
            onClose()
          }}
        />
      </div>

      <form method="dialog" className="modal-backdrop">
        <button type="button" disabled={submitting} onClick={closeDialog}>
          {t("common.close")}
        </button>
      </form>
    </dialog>
  )
}

export default EditStudent
