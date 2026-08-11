import { useTranslation } from "react-i18next"
import { Alert, FormField, Input, Select, Textarea } from "@/components/ui"
import {
  parseSubmissionTags,
  validateSubmissionTags,
} from "@/util/submissionTags"
import { GRADING_MAX_POINTS_MIN } from "@/types/classroom"
import type { AssignmentForm } from "../assignmentFormModel"
import { deriveFormShape } from "../formShape"
import type { SectionStatus } from "./sectionStatus"
import { SectionCard } from "./SectionCard"

// Submission and Grading: how the assignment is graded (off / auto / manual,
// with a manual max-points) and — when a built-in shim exists — what triggers
// the autograder (every push vs. on submit only, plus milestone tags).
//
// The grading controls apply to ANY assignment (a bare or teacher-CI repo can
// still be graded by hand), so the section always renders. The submission
// trigger + milestone tags only matter with a built-in shim (they are mutually
// exclusive with empty_repo / no_autograder on the wire), so those sub-controls
// stay gated on showBuiltInConfig. Hidden fields keep their (default) values, so
// the wire stays correct.
export function SubmissionGradingSection({
  form,
  edit,
  status,
}: {
  form: AssignmentForm
  edit: boolean
  status: SectionStatus
}) {
  const { t } = useTranslation()

  return (
    <SectionCard
      title={t("assignments.form.submissionSection")}
      status={status}
      description={t("assignments.form.submissionSectionHelp")}
    >
      <div className="flex flex-col gap-4">
        <GradingChoiceField form={form} edit={edit} />
        {/* Submission trigger + milestone tags need a built-in shim; hidden for
            a bare repo or teacher-supplied CI. */}
        <form.Subscribe
          selector={(state) => deriveFormShape(state.values).showBuiltInConfig}
        >
          {(showBuiltInConfig) =>
            showBuiltInConfig ? (
              <>
                <div className="divider my-0" />
                <SubmissionModeField form={form} edit={edit} />
                <SubmissionTagsField form={form} edit={edit} />
              </>
            ) : null
          }
        </form.Subscribe>
      </div>
    </SectionCard>
  )
}

// Grading choice (off / auto / manual). manual reveals a max-points input; auto
// shows a pointer to the Autograding section + the result.json requirement.
// The mode is immutable after creation, so on edit a change warns.
function GradingChoiceField({
  form,
  edit,
}: {
  form: AssignmentForm
  edit: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-3">
      <form.Field name="grading_choice">
        {(field) => (
          <div>
            <FormField
              htmlFor={field.name}
              label={t("assignments.form.grading.label")}
              help={t("assignments.form.grading.help")}
            >
              {({ id, describedById }) => (
                <Select
                  id={id}
                  name={field.name}
                  className="w-full sm:max-w-xs"
                  aria-describedby={describedById}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) =>
                    field.handleChange(e.target.value as typeof field.state.value)
                  }
                >
                  <option value="off">
                    {t("assignments.form.grading.choices.off")}
                  </option>
                  <option value="auto">
                    {t("assignments.form.grading.choices.auto")}
                  </option>
                  <option value="manual">
                    {t("assignments.form.grading.choices.manual")}
                  </option>
                </Select>
              )}
            </FormField>
            {edit ? (
              <form.Subscribe selector={(state) => state.values.grading_choice}>
                {(choice) =>
                  choice !==
                  (form.options.defaultValues?.grading_choice ?? "auto") ? (
                    <Alert tone="warning" role="status" className="mt-2 text-sm">
                      <span>{t("assignments.form.grading.editWarning")}</span>
                    </Alert>
                  ) : null
                }
              </form.Subscribe>
            ) : null}
          </div>
        )}
      </form.Field>

      {/* manual -> max points; auto -> result.json pointer. Keyed off the live
          choice so switching modes reveals the right affordance. */}
      <form.Subscribe selector={(state) => state.values.grading_choice}>
        {(choice) =>
          choice === "manual" ? (
            <ManualMaxPointsField form={form} />
          ) : choice === "auto" ? (
            <Alert tone="info" role="note" className="text-sm">
              <span>{t("assignments.form.grading.autoNote")}</span>
            </Alert>
          ) : null
        }
      </form.Subscribe>
    </div>
  )
}

function ManualMaxPointsField({ form }: { form: AssignmentForm }) {
  const { t } = useTranslation()
  return (
    <form.Field name="grading_max_points">
      {(field) => {
        const error = field.state.meta.errors[0] as string | undefined
        return (
          <div>
            <FormField
              htmlFor={field.name}
              label={t("assignments.form.grading.maxPoints.label")}
              help={t("assignments.form.grading.maxPoints.help")}
            >
              {({ id, describedById }) => (
                <Input
                  id={id}
                  name={field.name}
                  type="number"
                  inputMode="numeric"
                  min={GRADING_MAX_POINTS_MIN}
                  step={1}
                  className="w-28"
                  aria-describedby={describedById}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(Number(e.target.value))}
                />
              )}
            </FormField>
            {error ? (
              <p role="alert" className="mt-1.5 text-sm text-error">
                {error}
              </p>
            ) : null}
          </div>
        )
      }}
    </form.Field>
  )
}

function SubmissionModeField({
  form,
  edit,
}: {
  form: AssignmentForm
  edit: boolean
}) {
  const { t } = useTranslation()
  return (
    <form.Field name="submission_mode">
      {(field) => (
        <div>
          <FormField
            htmlFor={field.name}
            label={t("assignments.form.submissionMode.label")}
            help={t("assignments.form.submissionMode.help")}
          >
            {({ id, describedById }) => (
              <Select
                id={id}
                name={field.name}
                className="w-full sm:max-w-xs"
                aria-describedby={describedById}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) =>
                  field.handleChange(e.target.value as typeof field.state.value)
                }
              >
                <option value="every-push">
                  {t("assignments.form.submissionMode.choices.everyPush")}
                </option>
                <option value="tag">
                  {t("assignments.form.submissionMode.choices.tag")}
                </option>
              </Select>
            )}
          </FormField>
          {edit ? (
            <form.Subscribe selector={(state) => state.values.submission_mode}>
              {(mode) =>
                mode !==
                (form.options.defaultValues?.submission_mode ??
                  "every-push") ? (
                  <Alert tone="warning" role="status" className="mt-2 text-sm">
                    <span>
                      {t("assignments.form.submissionMode.editWarning")}
                    </span>
                  </Alert>
                ) : null
              }
            </form.Subscribe>
          ) : null}
        </div>
      )}
    </form.Field>
  )
}

function SubmissionTagsField({
  form,
  edit,
}: {
  form: AssignmentForm
  edit: boolean
}) {
  const { t } = useTranslation()
  return (
    <form.Field name="submission_tags">
      {(field) => {
        const error = field.state.meta.errors[0] as string | undefined
        return (
          <div>
            <FormField
              htmlFor={field.name}
              label={t("assignments.form.submissionTags.label")}
              help={t("assignments.form.submissionTags.help")}
            >
              {({ id, describedById }) => (
                <Textarea
                  id={id}
                  name={field.name}
                  className="font-mono w-full sm:max-w-xs"
                  rows={3}
                  spellCheck={false}
                  placeholder={"phase1\nphase2\ncomplete"}
                  aria-describedby={describedById}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              )}
            </FormField>
            {error ? (
              <p role="alert" className="mt-1.5 text-sm text-error">
                {error}
              </p>
            ) : null}
            <form.Subscribe selector={(state) => state.values.submission_tags}>
              {(tags) => {
                // Surface the same problems the save-time validator catches,
                // live and ahead of save (the form only validates onSubmit).
                // Priority, most to least actionable:
                //   1. comma — the obvious wrong guess for a one-per-line
                //      field; its own friendly hint since the generic charset
                //      error wouldn't explain the real fix.
                //   2. a hard validation error (bad charset, duplicate,
                //      stacked quantifier) — the exact save-path message.
                //   3. broad-glob caution / edit-retrofit warning — advisory.
                const parsed = parseSubmissionTags(tags)
                const hasComma = (tags ?? "").includes(",")
                const validationError = validateSubmissionTags(parsed)
                const broad = parsed.some(
                  (p) => p.includes("*") || p.includes("+"),
                )
                const changed =
                  edit &&
                  tags !== (form.options.defaultValues?.submission_tags ?? "")
                if (!hasComma && !validationError && !broad && !changed)
                  return null
                const message = hasComma
                  ? t("assignments.form.submissionTags.commaHint")
                  : (validationError ??
                    (broad
                      ? t("assignments.form.submissionTags.wildcardCaution")
                      : t("assignments.form.submissionMode.editWarning")))
                // Errors read as errors; the advisory cautions stay warning.
                const isError = hasComma || Boolean(validationError)
                return (
                  <Alert
                    tone={isError ? "error" : "warning"}
                    role="status"
                    className="mt-2 text-sm"
                  >
                    <span>{message}</span>
                  </Alert>
                )
              }}
            </form.Subscribe>
          </div>
        )
      }}
    </form.Field>
  )
}
