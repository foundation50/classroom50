import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui"
import { DetailsSection } from "./sections/DetailsSection"
import { RepositorySetupSection } from "./sections/RepositorySetupSection"
import { AutogradingSection } from "./sections/AutogradingSection"
import { SubmissionGradingSection } from "./sections/SubmissionGradingSection"
import { ScheduleSection } from "./sections/ScheduleSection"
import {
  SECTION_FIELDS,
  sectionIsConfigured,
  errorKeyMatchesField,
  type SectionId,
} from "./sections/sectionFields"
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
  // Edit mode: whether any student has already accepted this assignment. Gates
  // the provisioning-change caveats (repo source, built-in autograder) so they
  // only show when a change would actually strand existing repos. Absent/false
  // on create and when nobody has accepted.
  hasAcceptedStudents?: boolean
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
  hasAcceptedStudents = false,
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

  // Restore one section's fields to their create defaults. Because
  // deriveFormShape is a pure view over values, resetting the owned fields also
  // restores that section's derived visibility (e.g. Repository's template
  // fields hide again). Offered on create only; edit mode uses Discard changes.
  const resetSection = (section: SectionId) => {
    const defaults = form.options.defaultValues as CreateAssignmentFormValues
    for (const field of SECTION_FIELDS[section]) {
      form.setFieldValue(field, defaults[field])
    }
    if (section === "details") {
      // Re-arm the name->slug auto-fill; the slug is back at its default.
      setSlugTouched(false)
    }
    if (section === "schedule") {
      // The date pickers are opt-in; a reset clears the dates, so collapse the
      // pickers to match (they seed from a present value otherwise).
      setDueDateEnabled(false)
      setAvailableFromEnabled(false)
    }
  }

  // Edit-mode discard: revert all unsaved edits to the stored assignment. The
  // schedule pickers' shown/hidden state lives in local state (seeded on mount),
  // so re-sync it from the restored values or a discard would leave a stored
  // date hidden behind a collapsed, out-of-sync picker.
  const discardChanges = () => {
    form.reset()
    const restored = form.options.defaultValues as CreateAssignmentFormValues
    setDueDateEnabled(Boolean(restored.due_date))
    setAvailableFromEnabled(Boolean(restored.available_from_date))
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        // Validate up front so we can point the teacher at the first problem
        // regardless of how (or whether) the form library propagates the
        // submit-validator errors onto individual field DOM nodes.
        const errors = validateAssignmentForm(form.state.values, t, {
          takenSlugs,
          edit,
        })
        // handleSubmit re-throws an onSubmit rejection (an edit-mode mutateAsync
        // failure); the caller's onError banner already surfaces it, so swallow
        // it here to avoid an unhandled rejection.
        void form.handleSubmit().catch(() => {})
        if (Object.keys(errors).length === 0) return
        // Error keys may be indexed (e.g. "tests[0].name"), so match the owning
        // field by prefix — in section render order, first errored field wins.
        const orderedFields = (
          Object.keys(SECTION_FIELDS) as SectionId[]
        ).flatMap((section) => SECTION_FIELDS[section])
        const firstErroredField = orderedFields.find((field) =>
          Object.keys(errors).some((key) => errorKeyMatchesField(key, field)),
        )
        if (!firstErroredField) return
        const target = document.getElementById(firstErroredField)
        if (!target) return
        target.scrollIntoView({ behavior: "smooth", block: "center" })
        target.focus({ preventScroll: true })
      }}
    >
      {/* readOnly disables every descendant control. */}
      <fieldset disabled={readOnly} className="m-0 min-w-0 border-0 p-0">
        {/* Per-section Reset (create only): shown when a section differs from
            its create defaults, restoring just that section in one click. Edit
            mode offers a single Discard changes affordance instead. */}
        <form.Subscribe selector={(state) => state.values}>
          {(values) => {
            const defaults = form.options
              .defaultValues as CreateAssignmentFormValues
            // Only create mode offers per-section reset; in edit mode the
            // baseline is the stored assignment and Discard changes reverts all.
            const onReset = (section: SectionId) =>
              !edit && sectionIsConfigured(section, values, defaults)
                ? () => resetSection(section)
                : undefined
            return (
              <>
                <DetailsSection
                  form={form}
                  edit={edit}
                  onReset={onReset("details")}
                  slugTouched={slugTouched}
                  setSlugTouched={setSlugTouched}
                  takenSlugs={takenSlugs}
                />
                <RepositorySetupSection
                  form={form}
                  edit={edit}
                  onReset={onReset("repository")}
                  org={org}
                  classroom={classroom}
                  slug={slug}
                  hasAcceptedStudents={hasAcceptedStudents}
                />
                <SubmissionGradingSection
                  form={form}
                  edit={edit}
                  onReset={onReset("submission")}
                />
                <AutogradingSection
                  form={form}
                  edit={edit}
                  onReset={onReset("autograding")}
                  org={org}
                  hasAcceptedStudents={hasAcceptedStudents}
                />
                <ScheduleSection
                  form={form}
                  onReset={onReset("schedule")}
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
              <>
                {/* Edit mode: revert all unsaved edits back to the stored
                    assignment. Shown only while the form is dirty. */}
                {edit && !isDefaultValue ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={discardChanges}
                    disabled={isSubmitting || loading}
                  >
                    {t("assignments.form.discardChanges")}
                  </Button>
                ) : null}
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
              </>
            )}
          </form.Subscribe>
        )}
      </div>
    </form>
  )
}

export default CreateAssignmentForm
