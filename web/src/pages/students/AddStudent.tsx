import { Mail, UserRound, Users } from "lucide-react"
import GitHub from "@/assets/github.svg?react"
import { revalidateLogic, useForm } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import useEnsureTeam from "@/hooks/useEnsureTeam"
import { invalidateInviteQueries } from "@/hooks/github/queries"
import { useUpdateRosterCache } from "@/hooks/useGetStudents"
import {
  useInvalidateTeamRoster,
  useSeedTeamMember,
} from "@/hooks/useTeamRoster"
import { enrollStudentInClassroom } from "@/hooks/github/mutations"
import { inviteByEmail } from "@/api/mutations/students"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { isValidEmail } from "@/util/orgMembership"
import { splitName, toStudent } from "@/util/roster"

type AddStudentProps = {
  className?: string
  org: string
  classroom: string
}

type AddStudentFormValues = {
  name: string
  username: string
  email: string
  section: string
}

// Single add/invite form. A username enrolls via GitHub (resolve, add to team,
// send org invite) and stores the email; email-only sends an email invite.
// Either way the student joins the classroom team on accepting the invite.
const AddStudent = ({ className = "", org, classroom }: AddStudentProps) => {
  const { team } = useEnsureTeam(org, classroom)
  const queryClient = useQueryClient()
  const githubClient = useGitHubClient()
  const updateRosterCache = useUpdateRosterCache(org, classroom)
  const invalidateTeamRoster = useInvalidateTeamRoster(org, classroom)
  const seedTeamMember = useSeedTeamMember(org, classroom)
  const { t } = useTranslation()
  const [warning, setWarning] = useState("")
  const [success, setSuccess] = useState("")

  const addMutation = useMutation({
    mutationFn: async (value: AddStudentFormValues) => {
      const { first_name, last_name } = splitName(value.name)
      const username = value.username.trim()
      const email = value.email.trim()
      const section = value.section.trim()

      // Username present -> GitHub enrolment (carry the email onto the row).
      if (username) {
        const result = await enrollStudentInClassroom(githubClient, {
          org,
          classroom,
          username,
          first_name,
          last_name,
          email: email || undefined,
          section: section || undefined,
        })
        return {
          kind: "username" as const,
          label: username,
          warning: result?.teamWarning ?? "",
          student: toStudent(result.student),
          // Already-active member: team-added directly (no invite), so seed the
          // members cache to avoid a "not in org" flash.
          enrolledMember: result.enrolled
            ? {
                id: Number(result.student.github_id),
                login: result.student.username,
              }
            : null,
        }
      }

      // Email-only -> a pure GitHub org invite (carrying the classroom team) and
      // NO students.csv write: the team is the enrollment source of truth and an
      // email carries no reliable identity. The invite surfaces in the roster's
      // "pending" section via the org pending-invitations list; name/section are
      // captured later by adding the student by username or uploading a roster.
      const result = await inviteByEmail(githubClient, {
        org,
        classroom,
        email,
      })
      return {
        kind: "email" as const,
        label: email,
        warning: result?.inviteWarning ?? "",
      }
    },
    onSuccess: (result) => {
      setWarning(result.warning)
      // Clear the form so the next student starts clean and a stray re-click
      // can't resubmit into a duplicate error.
      setSuccess(
        result.kind === "email"
          ? t("students.invited", { label: result.label })
          : t("students.added", { label: result.label }),
      )
      form.reset()
      invalidateInviteQueries(queryClient, org)
      if (result.kind === "username") {
        // Show the new row immediately (see useUpdateRosterCache).
        updateRosterCache((current) => [...current, result.student])
        // Enrolled member -> seed the team-members cache so the row shows
        // enrolled at once; the invited path already shows a pending invite, so
        // just invalidate.
        if (result.enrolledMember) {
          seedTeamMember(result.enrolledMember)
        } else {
          invalidateTeamRoster()
        }
      } else {
        // Email invite writes no CSV row; just refresh so the new pending
        // org-invitation shows in the roster.
        invalidateTeamRoster()
      }
    },
  })

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
      await addMutation.mutateAsync(value)
    },
  })

  return (
    <div className={`card card-border bg-base-100 shadow-sm ${className}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          e.stopPropagation()
          form.handleSubmit()
        }}
      >
        <div className="card-body">
          <p className="font-bold mb-2">{t("students.addTitle")}</p>
          <p className="text-xs text-base-content/70 mb-2">
            {t("students.addHint")}
          </p>

          {warning && (
            <div className="alert alert-warning alert-soft mb-2 text-sm">
              {warning}
            </div>
          )}

          {success && (
            <div className="alert alert-success alert-soft mb-2 text-sm">
              {success}
            </div>
          )}

          <form.Field name="name">
            {(field) => (
              <div className="flex mb-2 items-center">
                <UserRound
                  className="mr-2 text-base-content/70"
                  aria-hidden="true"
                />
                <input
                  id={field.name}
                  name={field.name}
                  type="text"
                  placeholder={t("students.namePlaceholder")}
                  aria-label={t("students.namePlaceholder")}
                  className="input w-full"
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </div>
            )}
          </form.Field>

          <form.Field name="username">
            {(field) => (
              <div className="mb-2">
                <div className="flex items-center">
                  <GitHub
                    className="size-6 mr-2 text-base-content/30 opacity-25"
                    aria-hidden="true"
                  />
                  <input
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
                    className="input w-full"
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
            )}
          </form.Field>

          <form.Field name="email">
            {(field) => (
              <div className="mb-4">
                <div className="flex items-center">
                  <Mail
                    className="size-6 mr-2 text-base-content/70"
                    aria-hidden="true"
                  />
                  <input
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
                    className="input w-full"
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
            )}
          </form.Field>

          <form.Field name="section">
            {(field) => (
              <div className="flex mb-4 items-center">
                <Users
                  className="mr-2 text-base-content/70"
                  aria-hidden="true"
                />
                <input
                  id={field.name}
                  name={field.name}
                  type="text"
                  placeholder={t("students.sectionPlaceholder")}
                  aria-label={t("students.sectionAria")}
                  className="input w-full"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </div>
            )}
          </form.Field>

          <form.Subscribe
            selector={(state) => [state.canSubmit, state.isSubmitting]}
          >
            {([canSubmit, isSubmitting]) => (
              <button
                type="submit"
                disabled={!canSubmit || isSubmitting || !team}
                className="btn btn-primary w-full"
              >
                {!isSubmitting
                  ? t("students.addButton")
                  : t("students.submitting")}
              </button>
            )}
          </form.Subscribe>
        </div>
      </form>
    </div>
  )
}

export default AddStudent
