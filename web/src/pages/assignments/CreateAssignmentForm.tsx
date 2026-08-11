import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui"
import { DetailsSection } from "./sections/DetailsSection"
import { RepositorySetupSection } from "./sections/RepositorySetupSection"
import { AutogradingSection } from "./sections/AutogradingSection"
import { RepositoryFeaturesSection } from "./sections/RepositoryFeaturesSection"
import { ScheduleSection } from "./sections/ScheduleSection"
import { deriveSectionStatus } from "./sections/sectionStatus"
import {
  useAssignmentForm,
  validateAssignmentForm,
  type AssignmentForm,
  type CreateAssignmentFormValues,
} from "./assignmentFormModel"

// EditAssignmentForm (and the create-form test) map a stored assignment to form
// values through this module; the rest of the model's surface is imported from
// assignmentFormModel directly.
export { assignmentToFormValues } from "./assignmentFormModel"
export { formValuesToRepoFeatures } from "./assignmentFormModel"

// The whole-form error list (submit-time validation errors that aren't bound to
// a single field). Rendered once below the sections.
const FormErrors = ({ form }: { form: AssignmentForm }) => (
  <form.Subscribe selector={(state) => [state.errors]}>
    {([errors]) => (
      <div>
        {errors.map((err) => (
          <p className="text-error" key={String(err)}>
            {String(err)}
          </p>
        ))}
      </div>
    )}
  </form.Subscribe>
)

type CreateAssignmentFormProps = {
  defaultValues?: Partial<CreateAssignmentFormValues>
  onSubmit: (values: CreateAssignmentFormValues) => void | Promise<void>
  onCancel?: () => void
  edit?: boolean
  loading?: boolean
  // Render every field/button disabled (e.g., an archived classroom). A disabled
  // <fieldset> natively disables all descendant controls, including submit.
  readOnly?: boolean
  // Org slug for verifying a runner label against the org's self-hosted
  // runners. When absent, verification never blocks.
  org?: string
  // Classroom slug; template pre-flight uses it to check whether the classroom
  // team already has read on an in-org private template.
  classroom?: string
  // Assignment slug (edit mode only); enables TemplateField's inline "Fix
  // template access" recovery button. Absent on create.
  slug?: string
  // Existing assignment slugs, for the create-mode uniqueness check.
  takenSlugs?: string[]
}

const CreateAssignmentForm = ({
  defaultValues,
  onSubmit,
  onCancel,
  edit = false,
  loading = false,
  readOnly = false,
  org,
  classroom,
  slug,
  takenSlugs,
}: CreateAssignmentFormProps) => {
  const { t } = useTranslation()
  const form = useAssignmentForm(defaultValues, onSubmit, t, {
    takenSlugs,
    edit,
  })
  // Auto-prefill slug from name until the teacher edits it directly, so a
  // deliberate slug isn't clobbered by later name edits.
  const [slugTouched, setSlugTouched] = useState(false)
  // Whether the due-date picker is shown. Seeded from the initial value (Edit of
  // an assignment with a due starts checked); a due date is opt-in otherwise.
  // Unchecking clears due_date so the write path omits it (#195).
  const [dueDateEnabled, setDueDateEnabled] = useState(
    Boolean(form.state.values.due_date),
  )
  // Whether the release-date picker is shown. Seeded from the initial value;
  // a release date is opt-in. Unchecking clears available_from_date so the
  // write path omits it (mirrors the due-date toggle).
  const [availableFromEnabled, setAvailableFromEnabled] = useState(
    Boolean(form.state.values.available_from_date),
  )

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        // handleSubmit re-throws an onSubmit rejection (an edit-mode mutateAsync
        // failure); the caller's onError banner already surfaces it, so swallow
        // it here to avoid an unhandled rejection.
        void form.handleSubmit().catch(() => {})
      }}
    >
      {/* readOnly disables every descendant control. */}
      <fieldset disabled={readOnly} className="m-0 min-w-0 border-0 p-0">
        {/* Per-section status (R2): derived from the live form values against
            the baseline defaults and the same validator the save path uses, so
            each section header reflects error / configured / default. */}
        <form.Subscribe
          selector={(state) => [state.values, state.errorMap.onSubmit] as const}
        >
          {([values]) => {
            const defaults = form.options
              .defaultValues as CreateAssignmentFormValues
            const errors = validateAssignmentForm(values, t, {
              takenSlugs,
              edit,
            })
            return (
              <>
                <DetailsSection
                  form={form}
                  edit={edit}
                  status={deriveSectionStatus(
                    "details",
                    values,
                    defaults,
                    errors,
                  )}
                  slugTouched={slugTouched}
                  setSlugTouched={setSlugTouched}
                />
                <RepositorySetupSection
                  form={form}
                  edit={edit}
                  status={deriveSectionStatus(
                    "repository",
                    values,
                    defaults,
                    errors,
                  )}
                  org={org}
                  classroom={classroom}
                  slug={slug}
                />
                <AutogradingSection
                  form={form}
                  edit={edit}
                  status={deriveSectionStatus(
                    "autograding",
                    values,
                    defaults,
                    errors,
                  )}
                  org={org}
                />
                <RepositoryFeaturesSection
                  form={form}
                  status={deriveSectionStatus(
                    "features",
                    values,
                    defaults,
                    errors,
                  )}
                />
                <ScheduleSection
                  form={form}
                  status={deriveSectionStatus(
                    "schedule",
                    values,
                    defaults,
                    errors,
                  )}
                  dueDateEnabled={dueDateEnabled}
                  setDueDateEnabled={setDueDateEnabled}
                  availableFromEnabled={availableFromEnabled}
                  setAvailableFromEnabled={setAvailableFromEnabled}
                />
              </>
            )
          }}
        </form.Subscribe>
        <FormErrors form={form} />
      </fieldset>
      <div className="divider" />
      <div className="card-actions justify-end p-2">
        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={loading}
          >
            {readOnly ? t("assignments.form.back") : t("common.cancel")}
          </Button>
        )}
        {!readOnly && (
          <form.Subscribe
            selector={(state) => [
              state.canSubmit,
              state.isSubmitting,
              state.isDefaultValue,
            ]}
          >
            {([canSubmit, isSubmitting, isDefaultValue]) => (
              <Button
                variant="primary"
                type="submit"
                loading={isSubmitting || loading}
                disabled={
                  !canSubmit ||
                  isSubmitting ||
                  loading ||
                  (edit && isDefaultValue)
                }
              >
                {isSubmitting || loading
                  ? null
                  : edit
                    ? t("assignments.form.saveChanges")
                    : t("assignments.form.createButton")}
              </Button>
            )}
          </form.Subscribe>
        )}
      </div>
    </form>
  )
}

export default CreateAssignmentForm
