import { Mail, UserRound, Users } from "lucide-react"
import { revalidateLogic, useForm } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import GitHub from "@/assets/github.svg?react"
import { updateStudentWithConflictRetry } from "@/api/mutations/students"
import { getErrorMessage } from "@/hooks/github/mutations"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import { isValidEmail } from "@/util/onboarding"
import { studentKey } from "@/util/roster"
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

type EditStudentFormValues = {
  first_name: string
  last_name: string
  email: string
  section: string
}

// Edit modal for a roster row's teacher-facing fields. Identity (username,
// github_id, email) is shown read-only until the student is enrolled — it's
// bound by membership, not the teacher — and first/last name and section stay
// editable. Once enrolled, the email becomes editable too.
const EditStudent = ({
  org,
  classroom,
  student,
  open,
  onClose,
  onSaved,
}: EditStudentProps) => {
  const client = useGitHubClient()
  const runSave = useSafeSubmit()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)

  const displayHandle = student.username || student.email
  // An email-only row (no username, no github_id) is keyed by its email, so it
  // can't be changed here without re-keying the row. A github-identified row's
  // email is just metadata and is freely editable.
  const emailLocked = !student.username && !student.github_id

  const defaults = useCallback(
    (): EditStudentFormValues => ({
      first_name: student.first_name ?? "",
      last_name: student.last_name ?? "",
      email: student.email ?? "",
      section: student.section ?? "",
    }),
    [student],
  )

  const updateMutation = useMutation({
    mutationFn: (value: EditStudentFormValues) =>
      updateStudentWithConflictRetry(client, {
        org,
        classroom,
        key: studentKey(student),
        patch: {
          first_name: value.first_name.trim(),
          last_name: value.last_name.trim(),
          email: value.email.trim(),
          section: value.section.trim(),
        },
      }),
  })

  const form = useForm({
    defaultValues: defaults(),
    // Validate on submit, then re-validate on change so a corrected field clears
    // its error and the button recovers (mirrors AddStudent).
    validationLogic: revalidateLogic(),
    validators: {
      onDynamic: ({ value }) => {
        const email = value.email.trim()
        if (email && !isValidEmail(email)) {
          return { fields: { email: t("validation.validEmail") } }
        }
        return undefined
      },
    },
    onSubmit: async ({ value }) => {
      setError(null)
      // Re-entrancy guard around the awaitable write. runSave swallows the
      // rejection, so capture the error inside fn before it propagates.
      await runSave(async () => {
        try {
          const result = await updateMutation.mutateAsync(value)
          onSaved(result.student)
          onClose()
        } catch (err) {
          setError(getErrorMessage(err))
          throw err
        }
      })
    },
  })

  // Drive the native dialog from the `open` prop. Reset to the student's CURRENT
  // values on open: this dialog is never remounted (its row key is stable), so
  // an argument-less reset would restore mount-time values that go stale after a
  // save.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      setError(null)
      form.reset(defaults())
      dialog.showModal()
    }
    if (!open && dialog.open) {
      dialog.close()
    }
  }, [open, form, defaults])

  const submitting = form.state.isSubmitting

  const closeDialog = () => {
    if (submitting) return
    onClose()
  }

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

        <form
          onSubmit={(e) => {
            e.preventDefault()
            e.stopPropagation()
            form.handleSubmit()
          }}
        >
          <div className="mt-4 flex flex-col gap-3">
            <form.Field name="first_name">
              {(field) => (
                <div className="flex items-center">
                  <UserRound
                    className="mr-2 text-base-content/70"
                    aria-hidden="true"
                  />
                  <input
                    id={field.name}
                    name={field.name}
                    type="text"
                    placeholder={t("students.firstNamePlaceholder")}
                    aria-label={t("students.firstNamePlaceholder")}
                    className="input w-full"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                </div>
              )}
            </form.Field>

            <form.Field name="last_name">
              {(field) => (
                <div className="flex items-center">
                  <UserRound
                    className="mr-2 text-base-content/70"
                    aria-hidden="true"
                  />
                  <input
                    id={field.name}
                    name={field.name}
                    type="text"
                    placeholder={t("students.lastNamePlaceholder")}
                    aria-label={t("students.lastNamePlaceholder")}
                    className="input w-full"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                </div>
              )}
            </form.Field>

            <form.Field name="email">
              {(field) => {
                const emailHelp = emailLocked
                  ? t("students.emailHelpNoIdentity")
                  : null
                return (
                  <div>
                    <div className="flex items-center">
                      <Mail
                        className="size-6 mr-2 text-base-content/70"
                        aria-hidden="true"
                      />
                      <input
                        id={field.name}
                        name={field.name}
                        type="email"
                        placeholder={t("students.editEmailPlaceholder")}
                        aria-label={t("students.emailLabel")}
                        aria-invalid={field.state.meta.errors.length > 0}
                        aria-describedby={
                          field.state.meta.errors.length > 0
                            ? `${field.name}-error`
                            : undefined
                        }
                        className="input w-full"
                        value={field.state.value}
                        disabled={emailLocked}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                      />
                    </div>
                    {field.state.meta.errors.length > 0 && (
                      <p
                        id={`${field.name}-error`}
                        className="text-error text-sm mt-1"
                        role="alert"
                      >
                        {String(field.state.meta.errors[0] ?? "")}
                      </p>
                    )}
                    {emailHelp ? (
                      <p className="mt-1 text-xs text-base-content/70">
                        {emailHelp}
                      </p>
                    ) : null}
                  </div>
                )
              }}
            </form.Field>

            <form.Field name="section">
              {(field) => (
                <div className="flex items-center">
                  <Users
                    className="mr-2 text-base-content/70"
                    aria-hidden="true"
                  />
                  <input
                    id={field.name}
                    name={field.name}
                    type="text"
                    placeholder={t("students.editSectionPlaceholder")}
                    aria-label={t("students.sectionLabel")}
                    className="input w-full"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                </div>
              )}
            </form.Field>

            {student.username ? (
              <div className="flex items-center gap-2 rounded-box border border-base-300 bg-base-200/50 px-3 py-2 text-sm text-base-content/70">
                <GitHub aria-hidden="true" className="size-5 opacity-40" />
                <span>
                  {t("students.githubLabel")}{" "}
                  <span className="font-mono">@{student.username}</span>
                  {student.github_id
                    ? t("students.githubIdSuffix", { id: student.github_id })
                    : ""}
                </span>
              </div>
            ) : null}
          </div>

          {error ? (
            <div className="alert alert-error alert-soft mt-4 text-sm">
              {error}
            </div>
          ) : null}

          <div className="modal-action">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={submitting}
              onClick={closeDialog}
            >
              {t("common.cancel")}
            </button>
            <form.Subscribe
              selector={(state) => [state.canSubmit, state.isSubmitting]}
            >
              {([canSubmit, isSubmitting]) => (
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!canSubmit || isSubmitting}
                >
                  {isSubmitting ? (
                    <>
                      <span
                        className="loading loading-spinner loading-sm"
                        aria-hidden="true"
                      />
                      {t("students.saving")}
                    </>
                  ) : (
                    t("students.saveChanges")
                  )}
                </button>
              )}
            </form.Subscribe>
          </div>
        </form>
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
