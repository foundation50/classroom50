import { useTranslation } from "react-i18next"
import { Alert, FormField, Input, Select } from "@/components/ui"
import { GRADING_MAX_POINTS_MIN } from "@/types/classroom"
import type { AssignmentForm } from "../assignmentFormModel"
import { deriveFormShape } from "../formShape"
import type { SectionStatus } from "./sectionStatus"
import { SectionCard } from "./SectionCard"
import { SubmissionsSubsection } from "./SubmissionsSubsection"

// Submission and Grading: how the assignment is graded (off / auto / manual,
// with a manual max-points) and — under the Submissions subsection — what
// counts as a submission (the definition + milestone tags).
//
// The grading controls and the submission DEFINITION both apply to ANY
// assignment (a bare or teacher-CI repo can still be graded by hand and can
// still declare what counts as a submission), so they always render. Only the
// shim-dependent affordances inside the Submissions subsection (milestone tags,
// the retrofit edit warning) stay gated on showBuiltInConfig, because a bare
// repo or teacher-supplied CI has no shim to trigger. Hidden fields keep their
// (default) values, so the wire stays correct.
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
        <div className="divider my-0" />
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">
            {t("assignments.form.submissions.heading")}
          </h3>
          <p className="text-sm text-base-content/70">
            {t("assignments.form.submissions.help")}
          </p>
          <form.Subscribe
            selector={(state) =>
              deriveFormShape(state.values).showBuiltInConfig
            }
          >
            {(showBuiltInConfig) => (
              <SubmissionsSubsection
                form={form}
                edit={edit}
                showBuiltInConfig={showBuiltInConfig}
              />
            )}
          </form.Subscribe>
        </div>
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
                    field.handleChange(
                      e.target.value as typeof field.state.value,
                    )
                  }
                >
                  <option value="off">
                    {t("assignments.form.grading.choices.off")}
                  </option>
                  <option value="manual">
                    {t("assignments.form.grading.choices.manual")}
                  </option>
                  <option value="auto">
                    {t("assignments.form.grading.choices.auto")}
                  </option>
                </Select>
              )}
            </FormField>
            {edit ? (
              <form.Subscribe selector={(state) => state.values.grading_choice}>
                {(choice) =>
                  choice !==
                  (form.options.defaultValues?.grading_choice ?? "auto") ? (
                    <Alert
                      tone="warning"
                      role="status"
                      className="mt-2 text-sm"
                    >
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
