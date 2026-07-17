import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button, Card } from "@/components/ui"
import { DetailsSection } from "./DetailsSection"
import { AdvancedSection } from "./AdvancedSection"
import AutogradingTestsPane from "./AutogradingTestsPane"
import {
  useAssignmentForm,
  type CreateAssignmentFormValues,
} from "./assignmentFormModel"

// EditAssignmentForm (and the create-form test) map a stored assignment to form
// values through this module; the rest of the model's surface is imported from
// assignmentFormModel directly.
export { assignmentToFormValues } from "./assignmentFormModel"

type CreateAssignmentFormProps = {
  defaultValues?: Partial<CreateAssignmentFormValues>
  onSubmit: (values: CreateAssignmentFormValues) => void | Promise<void>
  onCancel?: () => void
  edit?: boolean
  loading?: boolean
  // Render every field/button disabled (e.g. an archived classroom). A disabled
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

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        form.handleSubmit()
      }}
    >
      {/* readOnly disables every descendant control. */}
      <fieldset disabled={readOnly} className="m-0 min-w-0 border-0 p-0">
        <DetailsSection
          form={form}
          edit={edit}
          org={org}
          classroom={classroom}
          slug={slug}
          slugTouched={slugTouched}
          setSlugTouched={setSlugTouched}
          dueDateEnabled={dueDateEnabled}
          setDueDateEnabled={setDueDateEnabled}
        />

        <Card bordered={false} className="w-full mb-6">
          <Card.Body>
            <AdvancedSection form={form} org={org} />
          </Card.Body>
        </Card>

        <AutogradingTestsPane form={form} />
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
