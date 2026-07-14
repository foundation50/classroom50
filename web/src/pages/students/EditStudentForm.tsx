import { Mail, UserRound, Users } from "lucide-react"
import { revalidateLogic, useForm } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import GitHub from "@/assets/github.svg?react"
import { updateStudentWithConflictRetry } from "@/domain/students"
import { getErrorMessage } from "@/github-core/errorMessage"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import { isValidEmail } from "@/util/orgMembership"
import { studentKey } from "@/util/roster"
import type { Student } from "@/types/classroom"
import type { StudentCsvRow } from "@/domain/students"
import { AnimatedAlert, Button, Input } from "@/components/ui"

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
// `resetSignal` lets a parent that keeps the form mounted (e.g. a detail modal
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
  // the GitHub identity elsewhere (e.g. the roster detail modal's header).
  showGitHubPanel?: boolean
}) => {
  const client = useGitHubClient()
  const runSave = useSafeSubmit()
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
        // Seed a row if none exists yet (a team member — often staff — added on
        // GitHub before the roster synced their blank row), so editing upserts.
        identity: {
          github_id: student.github_id,
          username: student.username,
          email: student.email,
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
  // every render (e.g. the roster modal's `rowToStudent(row)`), so keying on it
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
              <Input
                id={field.name}
                name={field.name}
                placeholder={t("students.firstNamePlaceholder")}
                aria-label={t("students.firstNamePlaceholder")}
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
              <Input
                id={field.name}
                name={field.name}
                placeholder={t("students.lastNamePlaceholder")}
                aria-label={t("students.lastNamePlaceholder")}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </div>
          )}
        </form.Field>

        <form.Field name="email">
          {(field) => {
            return (
              <div>
                <div className="flex items-center">
                  <Mail
                    className="size-6 mr-2 text-base-content/70"
                    aria-hidden="true"
                  />
                  <Input
                    id={field.name}
                    name={field.name}
                    type="email"
                    placeholder={t("students.editEmailPlaceholder")}
                    aria-label={t("students.emailLabel")}
                    invalid={field.state.meta.errors.length > 0}
                    aria-describedby={
                      field.state.meta.errors.length > 0
                        ? `${field.name}-error`
                        : undefined
                    }
                    value={field.state.value}
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
              </div>
            )
          }}
        </form.Field>

        <form.Field name="section">
          {(field) => (
            <div className="flex items-center">
              <Users className="mr-2 text-base-content/70" aria-hidden="true" />
              <Input
                id={field.name}
                name={field.name}
                placeholder={t("students.editSectionPlaceholder")}
                aria-label={t("students.sectionLabel")}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </div>
          )}
        </form.Field>

        {showGitHubPanel && student.username ? (
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

      <AnimatedAlert tone="error" show={!!error} className="mt-4 text-sm">
        {error}
      </AnimatedAlert>

      <div className="modal-action">
        <Button
          type="button"
          variant="ghost"
          disabled={submitting}
          onClick={onCancel}
        >
          {t("common.cancel")}
        </Button>
        <form.Subscribe
          selector={(state) => [state.canSubmit, state.isSubmitting]}
        >
          {([canSubmit, isSubmitting]) => (
            <Button
              type="submit"
              variant="primary"
              loading={isSubmitting}
              loadingLabel={t("students.saving")}
              disabled={!canSubmit || isSubmitting}
            >
              {isSubmitting ? t("students.saving") : t("students.saveChanges")}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  )
}

export default EditStudentForm
