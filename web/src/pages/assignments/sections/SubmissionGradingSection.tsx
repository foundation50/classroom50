import { useTranslation } from "react-i18next"
import { FormField, Input, Select } from "@/components/ui"
import { GRADING_MAX_POINTS_MIN } from "@/types/classroom"
import type { AssignmentForm } from "../assignmentFormModel"
import { shouldSeedBuiltInAutograder } from "../assignmentFormModel"
import { deriveFormShape } from "../formShape"
import { SectionCard } from "./SectionCard"
import { SubmissionsSubsection } from "./SubmissionsSubsection"
import { AutograderConfig } from "./AutograderConfig"

// Submission and Grading: what counts as a submission (the Submissions
// subsection — shown first, since grading is downstream of it), how the
// assignment is graded (off / auto / manual, with a manual max-points), and —
// only when "Autograded" is chosen — the autograder configuration folded in
// from the former standalone Autograding section.
//
// The submission definition and the grading controls both apply to ANY
// assignment (a bare or teacher-CI repo can still declare what counts as a
// submission and still be graded by hand), so they always render. Only the
// shim-retrofit edit warnings inside the Submissions subsection stay gated on
// showBuiltInConfig, because a bare repo or teacher-supplied CI has no shim to
// retrofit. Hidden warnings don't change values, so the wire stays correct.
export function SubmissionGradingSection({
  form,
  edit,
  onReset,
  org,
  classroom,
  slug,
  hasAcceptedStudents = false,
}: {
  form: AssignmentForm
  edit: boolean
  onReset?: () => void
  // Org slug for the autograder runner verification; threaded through to the
  // folded-in autograder config.
  org?: string
  // With `org`, locates the assignment's bundle folder in the config repo for
  // the tests pane's upload link. `slug` is edit-mode only.
  classroom?: string
  slug?: string
  // Edit mode: whether any student has already accepted. Gates the built-in
  // autograder change caveat inside the autograder config.
  hasAcceptedStudents?: boolean
}) {
  const { t } = useTranslation()

  return (
    <SectionCard
      title={t("assignments.form.submissionSection")}
      onReset={onReset}
      description={t("assignments.form.submissionSectionHelp")}
    >
      <div className="flex flex-col gap-4">
        <form.Subscribe
          selector={(state) => deriveFormShape(state.values).showBuiltInConfig}
        >
          {(showBuiltInConfig) => (
            <SubmissionsSubsection
              form={form}
              edit={edit}
              showBuiltInConfig={showBuiltInConfig}
            />
          )}
        </form.Subscribe>
        <div className="divider my-0" />
        <GradingChoiceField form={form} />
        {/* Autograder config folded in: shown only when grading is
            "Autograded" (showAutogradingConfig). For Manual / Not graded it
            renders nothing, so the common path stays short. */}
        <form.Subscribe
          selector={(state) =>
            deriveFormShape(state.values).showAutogradingConfig
          }
        >
          {(showAutogradingConfig) =>
            showAutogradingConfig ? (
              <>
                <div className="divider my-0" />
                <AutograderConfig
                  form={form}
                  org={org}
                  classroom={classroom}
                  slug={slug}
                  edit={edit}
                  hasAcceptedStudents={hasAcceptedStudents}
                />
              </>
            ) : null
          }
        </form.Subscribe>
      </div>
    </SectionCard>
  )
}

// Grading choice (off / auto / manual). manual reveals a max-points input;
// entering auto seeds the built-in autograder as a first-entry default (see
// shouldSeedBuiltInAutograder — a deliberate pick survives a round-trip). The
// autograder config itself renders in this same section, below, when auto is
// selected. Editable after creation; the edit form confirms before saving when
// students have already accepted (scores recorded under the old mode may be
// read differently), so no inline edit warning is needed here.
function GradingChoiceField({ form }: { form: AssignmentForm }) {
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
                  onChange={(e) => {
                    const previous = field.state.value
                    const next = e.target.value as typeof field.state.value
                    field.handleChange(next)
                    if (
                      shouldSeedBuiltInAutograder({
                        next,
                        previous,
                        autogradingState: form.state.values.autograding_state,
                        autogradingTouched: Boolean(
                          form.getFieldMeta("autograding_state")?.isDirty,
                        ),
                      })
                    ) {
                      // Seed as a default, not an edit: leaving the field
                      // pristine keeps a later grading round-trip from reading
                      // this as the teacher's deliberate pick.
                      form.setFieldValue("autograding_state", "built-in", {
                        dontUpdateMeta: true,
                      })
                    }
                  }}
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
          </div>
        )}
      </form.Field>

      {/* manual -> max points. auto no longer needs a pointer alert — the
          autograder config now renders directly below in this section. */}
      <form.Subscribe selector={(state) => state.values.grading_choice}>
        {(choice) =>
          choice === "manual" ? <ManualMaxPointsField form={form} /> : null
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
          <FormField
            htmlFor={field.name}
            label={t("assignments.form.grading.maxPoints.label")}
            help={t("assignments.form.grading.maxPoints.help")}
            error={error}
          >
            {({ id, describedById, invalid }) => (
              <Input
                id={id}
                name={field.name}
                type="number"
                inputMode="numeric"
                min={GRADING_MAX_POINTS_MIN}
                step={1}
                className="w-28"
                aria-describedby={describedById}
                invalid={invalid}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(Number(e.target.value))}
              />
            )}
          </FormField>
        )
      }}
    </form.Field>
  )
}
