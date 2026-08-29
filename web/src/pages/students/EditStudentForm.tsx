import { MarkGithubIcon } from "@/components/ui/icons"
import { revalidateLogic, useForm } from "@tanstack/react-form"
import { useCallback, useEffect, useId, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { useUpdateStudent } from "@/hooks/mutations/useUpdateStudent"
import { getErrorMessage } from "@/github-core/errorMessage"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import { isValidEmail } from "@/util/orgMembership"
import { studentKey } from "@/util/roster"
import type { Student } from "@/types/classroom"
import type { StudentCsvRow } from "@/domain/students"
import {
  FormField,
  AnimatedAlert,
  Button,
  Input,
  ModalFooterPortal,
  MonoLtr,
} from "@/components/ui"

export type EditStudentFormValues = {
  first_name: string
  last_name: string
  email: string
  section: string
}

// The teacher-facing metadata form for a roster row (first/last/email/section)
// with the read-only GitHub identity panel. Standalone (no dialog shell of its
// own) so it embeds directly in the roster detail modal — nesting a second
// `<dialog showModal>` inside another modal dialog is invalid.
//
// `resetSignal` lets a parent that keeps the form mounted (e.g., a detail modal
// reused across rows) reset field values to the current student on open; a
// changed value re-syncs from `defaults()`.
const EditStudentForm = ({
  org,
  classroom,
  student,
  resetSignal,
  onCancel,
  onSaved,
  onSubmittingChange,
  showGitHubPanel = true,
  lockEmail = false,
}: {
  org: string
  classroom: string
  student: Student
  resetSignal?: unknown
  onCancel: () => void
  onSaved: (updated: StudentCsvRow) => void
  // Lets a parent dialog block close (Escape/backdrop) while a save is running.
  onSubmittingChange?: (submitting: boolean) => void
  // The read-only "GitHub: @username" panel. Hidden when a parent already shows
  // the GitHub identity elsewhere (e.g., the roster detail modal's header).
  showGitHubPanel?: boolean
  // Show the address read-only. Set for a pending email invite, whose address IS
  // the row's identity and is hashed into its invite team name — rewriting it
  // would orphan the row from its own invitation.
  lockEmail?: boolean
}) => {
  const runSave = useSafeSubmit()
  // Ties the portaled footer submit button to this form element.
  const formId = useId()
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)

  const defaults = useCallback(
    (): EditStudentFormValues => ({
      first_name: student.first_name ?? "",
      last_name: student.last_name ?? "",
      email: student.email ?? "",
      section: student.section ?? "",
    }),
    [student],
  )

  const updateMutation = useUpdateStudent()

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
          const result = await updateMutation.mutateAsync({
            org,
            classroom,
            key: studentKey(student),
            patch: {
              first_name: value.first_name.trim(),
              last_name: value.last_name.trim(),
              // When the address is locked it is the row's identity, so send the
              // stored one rather than the field: a disabled input still submits,
              // and an emptied address would orphan the row from its invitation.
              email: lockEmail ? (student.email ?? "") : value.email.trim(),
              section: value.section.trim(),
            },
            // Seed a row if none exists yet (a team member — often staff — added
            // on GitHub before the roster synced their blank row), so editing
            // upserts.
            identity: {
              github_id: student.github_id,
              username: student.username,
              email: student.email,
            },
          })
          onSaved(result.student)
        } catch (err) {
          setError(getErrorMessage(err))
          throw err
        }
      })
    },
  })

  // Reset to the student's CURRENT values only when the parent deliberately
  // signals it (open, or a switch to a different row/edit session). `defaults`
  // is intentionally NOT a dependency: parents recreate the `student` object
  // every render (e.g., the roster modal's `rowToStudent(row)`), so keying on it
  // would re-run mid-submit — `form.reset` clears `isSubmitting`, so the Save
  // button would flicker back to enabled while the write is in flight.
  useEffect(() => {
    setError(null)
    form.reset(defaults())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal])

  const submitting = form.state.isSubmitting

  // On a successful save the parent unmounts this form (leaves edit mode) while
  // `submitting` is still true for that render, so the parent never sees the
  // trailing false — leaving its mirrored flag stuck true and the modal
  // non-closeable. Reset it on unmount so `busy` always clears.
  useEffect(() => {
    onSubmittingChange?.(submitting)
    return () => onSubmittingChange?.(false)
  }, [submitting, onSubmittingChange])

  return (
    <form
      id={formId}
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        form.handleSubmit()
      }}
    >
      <div className="mt-4 flex flex-col gap-3">
        <form.Field name="first_name">
          {(field) => (
            <FormField
              htmlFor={field.name}
              label={t("students.firstNameLabel")}
            >
              {({ id, describedById, invalid }) => (
                <Input
                  id={id}
                  name={field.name}
                  placeholder={t("students.firstNamePlaceholder")}
                  aria-describedby={describedById}
                  invalid={invalid}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              )}
            </FormField>
          )}
        </form.Field>

        <form.Field name="last_name">
          {(field) => (
            <FormField htmlFor={field.name} label={t("students.lastNameLabel")}>
              {({ id, describedById, invalid }) => (
                <Input
                  id={id}
                  name={field.name}
                  placeholder={t("students.lastNamePlaceholder")}
                  aria-describedby={describedById}
                  invalid={invalid}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              )}
            </FormField>
          )}
        </form.Field>

        <form.Field name="email">
          {(field) => (
            <FormField
              htmlFor={field.name}
              label={t("students.emailLabel")}
              error={
                field.state.meta.errors.length > 0
                  ? String(field.state.meta.errors[0] ?? "")
                  : undefined
              }
              hint={lockEmail ? t("students.inviteEmailLocked") : undefined}
            >
              {({ id, describedById, invalid }) => (
                <Input
                  id={id}
                  name={field.name}
                  type="email"
                  placeholder={t("students.editEmailPlaceholder")}
                  readOnly={lockEmail}
                  disabled={lockEmail}
                  title={
                    lockEmail ? t("students.inviteEmailLocked") : undefined
                  }
                  invalid={invalid}
                  aria-describedby={describedById}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              )}
            </FormField>
          )}
        </form.Field>

        <form.Field name="section">
          {(field) => (
            <FormField htmlFor={field.name} label={t("students.sectionLabel")}>
              {({ id, describedById, invalid }) => (
                <Input
                  id={id}
                  name={field.name}
                  placeholder={t("students.editSectionPlaceholder")}
                  aria-describedby={describedById}
                  invalid={invalid}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              )}
            </FormField>
          )}
        </form.Field>

        {showGitHubPanel && student.username ? (
          <div className="flex items-center gap-2 rounded-box border border-base-300 bg-base-200/50 px-3 py-2 text-sm text-base-content/70">
            <MarkGithubIcon aria-hidden="true" className="size-4 opacity-40" />
            <span>
              <Trans
                i18nKey={
                  student.github_id
                    ? "students.githubIdentity"
                    : "students.githubIdentityNoId"
                }
                values={{ username: student.username, id: student.github_id }}
                components={{ username: <MonoLtr /> }}
              />
            </span>
          </div>
        ) : null}
      </div>

      <AnimatedAlert tone="error" show={!!error} className="mt-4 text-sm">
        {error}
      </AnimatedAlert>

      {/* The buttons render in the host modal's footer row; `form={formId}`
          keeps the portaled submit wired to this form element. */}
      <ModalFooterPortal>
        <Button
          type="button"
          variant="ghost"
          disabled={submitting}
          onClick={onCancel}
        >
          {t("common.cancel")}
        </Button>
        <form.Subscribe selector={(state) => [state.isSubmitting]}>
          {([isSubmitting]) => (
            <Button
              type="submit"
              form={formId}
              variant="primary"
              loading={isSubmitting}
              loadingLabel={t("students.saving")}
              disabled={isSubmitting}
            >
              {isSubmitting ? t("students.saving") : t("students.saveChanges")}
            </Button>
          )}
        </form.Subscribe>
      </ModalFooterPortal>
    </form>
  )
}

export default EditStudentForm
