import { Mail, UserRound, Users } from "lucide-react"
import GitHub from "@/assets/github.svg?react"
import { revalidateLogic, useForm } from "@tanstack/react-form"
import { useEffect, useId, useState } from "react"
import { useTranslation } from "react-i18next"
import useEnsureTeam from "@/hooks/useEnsureTeam"
import { useEnrollOrInviteStudent } from "@/hooks/mutations/useEnrollOrInviteStudent"
import { getErrorMessage } from "@/github-core/errorMessage"
import { StudentAlreadyEnrolledError } from "@/domain/students"
import { isValidEmail } from "@/util/orgMembership"
import { AnimatedAlert, Button, Input, Modal } from "@/components/ui"

type AddStudentProps = {
  org: string
  classroom: string
  open: boolean
  onClose: () => void
  // Called with the enrolled GitHub login on a successful username enrollment,
  // so the parent can clear any session-unenroll suppression for that login.
  onEnrolled?: (username: string) => void
}

type AddStudentFormValues = {
  name: string
  username: string
  email: string
  section: string
}

// Add-one-student modal. A username enrolls via GitHub (resolve, add to team,
// send org invite) and stores the email; email-only sends an email invite.
// Either way the student joins the classroom team on accepting the invite. The
// form collects every roster.csv field (name, username, email, section).
const AddStudent = ({
  org,
  classroom,
  open,
  onClose,
  onEnrolled,
}: AddStudentProps) => {
  const { team } = useEnsureTeam(org, classroom)
  const { t } = useTranslation()
  const titleId = useId()
  const [warning, setWarning] = useState("")
  const [success, setSuccess] = useState("")

  const addMutation = useEnrollOrInviteStudent(org, classroom, onEnrolled)

  const form = useForm({
    defaultValues: {
      name: "",
      username: "",
      email: "",
      section: "",
    } satisfies AddStudentFormValues,
    // Validate on submit, then re-validate on every change after the first
    // attempt. Otherwise a failed form-level validation leaves canSubmit false
    // and never re-runs, so the button never recovers.
    validationLogic: revalidateLogic(),
    validators: {
      onDynamic: ({ value }) => {
        const errors: Partial<Record<keyof AddStudentFormValues, string>> = {}
        const username = value.username.trim()
        const email = value.email.trim()

        if (!username && !email) {
          errors.username = t("validation.githubOrEmailRequired")
        }
        if (email && !isValidEmail(email)) {
          errors.email = t("validation.validEmail")
        }

        return Object.keys(errors).length > 0 ? { fields: errors } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      setWarning("")
      setSuccess("")
      // onError already surfaces failures; swallow the rejection so it isn't
      // also recorded as a form-level error. UI effects (success/warning + form
      // reset) live here so they skip when the modal unmounts; the hook's
      // onSuccess owns the roster cache reconcile that must always run.
      await addMutation
        .mutateAsync(value, {
          onSuccess: (result) => {
            setWarning(result.warning)
            // Clear the form so the next student starts clean and a stray
            // re-click can't resubmit into a duplicate error.
            setSuccess(
              result.kind === "email"
                ? t("students.invited", { label: result.label })
                : t("students.added", { label: result.label }),
            )
            form.reset()
          },
          onError: (err) => {
            // Surface every failure as a non-blocking warning, keeping the modal
            // and form intact so the teacher can fix the entry or add someone
            // else.
            setSuccess("")
            const label = value.username.trim() || value.email.trim()
            if (err instanceof StudentAlreadyEnrolledError) {
              setWarning(t("students.alreadyEnrolled", { label: err.login }))
              return
            }
            setWarning(
              t("students.addFailed", { label, message: getErrorMessage(err) }),
            )
          },
        })
        .catch(() => {})
    },
  })

  const submitting = form.state.isSubmitting

  // Reset transient state whenever the modal opens (Modal owns the open/close
  // sync now).
  useEffect(() => {
    if (!open) return
    setWarning("")
    setSuccess("")
    form.reset()
  }, [open, form])

  const closeDialog = () => {
    if (submitting) return
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={closeDialog}
      closeDisabled={submitting}
      size="lg"
      aria-labelledby={titleId}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 id={titleId} className="text-lg font-bold">
            {t("students.addTitle")}
          </h3>
          <p className="mt-1 text-sm text-base-content/70">
            {t("students.addHint")}
          </p>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          e.stopPropagation()
          form.handleSubmit()
        }}
      >
        <AnimatedAlert tone="warning" show={!!warning} className="mt-4 text-sm">
          {warning}
        </AnimatedAlert>

        <AnimatedAlert tone="success" show={!!success} className="mt-4 text-sm">
          {success}
        </AnimatedAlert>

        <div className="mt-4 flex flex-col gap-3">
          <form.Field name="name">
            {(field) => (
              <Input
                leadingIcon={
                  <UserRound
                    className="size-4 text-base-content/50"
                    aria-hidden="true"
                  />
                }
                id={field.name}
                name={field.name}
                type="text"
                placeholder={t("students.namePlaceholder")}
                aria-label={t("students.namePlaceholder")}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </form.Field>

          <form.Field name="username">
            {(field) => (
              <div>
                <Input
                  leadingIcon={
                    <GitHub className="size-4 opacity-40" aria-hidden="true" />
                  }
                  id={field.name}
                  name={field.name}
                  type="text"
                  placeholder={t("students.usernamePlaceholder")}
                  aria-label={t("students.usernameAria")}
                  aria-invalid={field.state.meta.errors.length > 0}
                  aria-describedby={
                    field.state.meta.errors.length > 0
                      ? `${field.name}-error`
                      : undefined
                  }
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
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
            )}
          </form.Field>

          <form.Field name="email">
            {(field) => (
              <div>
                <Input
                  leadingIcon={
                    <Mail
                      className="size-4 text-base-content/50"
                      aria-hidden="true"
                    />
                  }
                  id={field.name}
                  name={field.name}
                  type="email"
                  placeholder={t("students.emailPlaceholder")}
                  aria-label={t("students.emailAria")}
                  aria-invalid={field.state.meta.errors.length > 0}
                  aria-describedby={
                    field.state.meta.errors.length > 0
                      ? `${field.name}-error`
                      : undefined
                  }
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
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
            )}
          </form.Field>

          <form.Field name="section">
            {(field) => (
              <Input
                leadingIcon={
                  <Users
                    className="size-4 text-base-content/50"
                    aria-hidden="true"
                  />
                }
                id={field.name}
                name={field.name}
                type="text"
                placeholder={t("students.sectionPlaceholder")}
                aria-label={t("students.sectionAria")}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </form.Field>
        </div>

        <div className="modal-action">
          <Button
            type="button"
            variant="ghost"
            disabled={submitting}
            onClick={closeDialog}
          >
            {t("common.close")}
          </Button>
          <form.Subscribe
            selector={(state) => [state.canSubmit, state.isSubmitting]}
          >
            {([canSubmit, isSubmitting]) => (
              <Button
                type="submit"
                disabled={!canSubmit || isSubmitting || !team}
                variant="primary"
              >
                {!isSubmitting
                  ? t("students.addButton")
                  : t("students.submitting")}
              </Button>
            )}
          </form.Subscribe>
        </div>
      </form>
    </Modal>
  )
}

export default AddStudent
