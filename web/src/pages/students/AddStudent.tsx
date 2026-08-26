import { revalidateLogic, useForm } from "@tanstack/react-form"
import { useEffect, useId, useState } from "react"
import { useTranslation } from "react-i18next"
import useEnsureTeam from "@/hooks/useEnsureTeam"
import { useEnrollOrInviteStudent } from "@/hooks/mutations/useEnrollOrInviteStudent"
import { useAddStaffMember } from "@/hooks/mutations/useAddStaffMember"
import { useToast } from "@/context/notifications/NotificationProvider"
import { GitHubAPIError } from "@/github-core/errors"
import { getErrorMessage } from "@/github-core/errorMessage"
import { StudentAlreadyEnrolledError } from "@/domain/students"
import { isValidEmail } from "@/util/orgMembership"
import { STAFF_ROLES, type StaffRole } from "@/types/classroom"
import { ROLE_LABEL_KEY } from "@/util/classroomRoleUI"
import type { ClassroomRole } from "@/authz"
import {
  AnimatedAlert,
  Button,
  FormField,
  Input,
  Modal,
  Select,
} from "@/components/ui"

// Roster "Add member" roles, in display order. Student (default) enrolls via the
// student team; teacher/TA delegate to the staff-team backend.
const MEMBER_ROLES: readonly ClassroomRole[] = ["student", ...STAFF_ROLES]

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
  first_name: string
  last_name: string
  username: string
  email: string
  section: string
}

// Add-one-member modal (org-owner only; the roster page hides its trigger for
// non-owners). A role picker selects student (default) vs. staff (teacher/TA).
// Student: a username enrolls via GitHub (resolve, add to team, send org invite)
// and stores name/email/section, or an email-only entry sends an email invite;
// either way the student joins the classroom team on accepting. Staff: identified
// by GitHub username only (name/email/section hidden) and delegated to the
// staff-team backend (useAddStaffMember), which grants config-repo access.
const AddStudent = ({
  org,
  classroom,
  open,
  onClose,
  onEnrolled,
}: AddStudentProps) => {
  const { team } = useEnsureTeam(org, classroom)
  const { t } = useTranslation()
  const { notify } = useToast()
  // Ties the footer's submit button (outside the <form> element) to the form.
  const formId = useId()
  const roleId = useId()
  const [warning, setWarning] = useState("")
  const [success, setSuccess] = useState("")
  const [role, setRole] = useState<ClassroomRole>("student")
  const isStaffRole = role !== "student"

  const addMutation = useEnrollOrInviteStudent(org, classroom, onEnrolled)
  const addStaffMutation = useAddStaffMember(org, classroom, {
    enterUsername: t("classes.staff.enterUsername"),
  })

  const form = useForm({
    defaultValues: {
      first_name: "",
      last_name: "",
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

        // Staff (teacher/TA) are identified by GitHub username only — the staff
        // backend takes no email/section, so a username is required and email is
        // ignored.
        if (isStaffRole) {
          if (!username) {
            errors.username = t("classes.staff.enterUsername")
          }
        } else {
          if (!username && !email) {
            errors.username = t("validation.githubOrEmailRequired")
          }
          if (email && !isValidEmail(email)) {
            errors.email = t("validation.validEmail")
          }
        }

        return Object.keys(errors).length > 0 ? { fields: errors } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      setWarning("")
      setSuccess("")
      if (isStaffRole) {
        await submitStaff(value.username, role)
        return
      }
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

  // Staff branch: delegate to the staff-team backend (config-repo write). A
  // successful add toasts and clears the username; failures stay in-modal as a
  // warning so the teacher can correct and retry.
  const submitStaff = async (username: string, staffRole: StaffRole) => {
    await addStaffMutation
      .mutateAsync(
        { username, role: staffRole },
        {
          onSuccess: ({ trimmed, role: addedRole }) => {
            form.reset()
            notify({
              tone: "success",
              durationMs: 5000,
              message: t("toasts.staffAdded", {
                username: trimmed,
                role: t(ROLE_LABEL_KEY[addedRole]),
              }),
            })
          },
          onError: (err) => {
            setSuccess("")
            const message =
              err instanceof GitHubAPIError && err.status === 404
                ? t("classes.staff.noSuchUser")
                : getErrorMessage(err)
            setWarning(t("classes.staff.addFailed", { message }))
          },
        },
      )
      .catch(() => {})
  }

  const submitting = form.state.isSubmitting || addStaffMutation.isPending

  // Reset transient state whenever the modal opens (Modal owns the open/close
  // sync now).
  useEffect(() => {
    if (!open) return
    setWarning("")
    setSuccess("")
    setRole("student")
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
      size="2xl"
      title={t("students.addTitle")}
      subtitle={
        isStaffRole ? t("students.addStaffHint") : t("students.addHint")
      }
      footer={
        <>
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
                form={formId}
                disabled={!canSubmit || isSubmitting || (!isStaffRole && !team)}
                variant="primary"
              >
                {!isSubmitting
                  ? t("students.addButton")
                  : t("students.submitting")}
              </Button>
            )}
          </form.Subscribe>
        </>
      }
    >
      <form
        id={formId}
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
          <div>
            <label htmlFor={roleId} className="mb-1 block text-sm font-medium">
              {t("students.addRoleLabel")}
            </label>
            <Select
              id={roleId}
              value={role}
              onChange={(e) => setRole(e.target.value as ClassroomRole)}
            >
              {MEMBER_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(ROLE_LABEL_KEY[r])}
                </option>
              ))}
            </Select>
          </div>

          {!isStaffRole && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                        type="text"
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
                  <FormField
                    htmlFor={field.name}
                    label={t("students.lastNameLabel")}
                  >
                    {({ id, describedById, invalid }) => (
                      <Input
                        id={id}
                        name={field.name}
                        type="text"
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
            </div>
          )}

          <form.Field name="username">
            {(field) => (
              <FormField
                htmlFor={field.name}
                label={t("students.usernameLabel")}
                error={
                  field.state.meta.errors.length > 0
                    ? String(field.state.meta.errors[0] ?? "")
                    : undefined
                }
              >
                {({ id, describedById, invalid }) => (
                  <Input
                    id={id}
                    name={field.name}
                    type="text"
                    placeholder={t("students.usernamePlaceholder")}
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

          {!isStaffRole && (
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
                  hint={t("students.emailInviteHint")}
                >
                  {({ id, describedById, invalid }) => (
                    <Input
                      id={id}
                      name={field.name}
                      type="email"
                      placeholder={t("students.emailPlaceholder")}
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
          )}

          {!isStaffRole && (
            <form.Field name="section">
              {(field) => (
                <FormField
                  htmlFor={field.name}
                  label={t("students.sectionLabel")}
                >
                  {({ id, describedById, invalid }) => (
                    <Input
                      id={id}
                      name={field.name}
                      type="text"
                      placeholder={t("students.sectionPlaceholder")}
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
          )}
        </div>
      </form>
    </Modal>
  )
}

export default AddStudent
