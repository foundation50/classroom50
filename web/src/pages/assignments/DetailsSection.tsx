import type { Dispatch, SetStateAction } from "react"
import { useTranslation } from "react-i18next"
import { slugify } from "@/util/slug"
import { Card, FormField, Input, Textarea } from "@/components/ui"
import { TemplateField } from "./TemplateField"
import { FieldLabel, ToggleRow } from "./AdvancedRuntimeFields"
import { GROUP_SIZE_MAX, GROUP_SIZE_MIN } from "@/types/classroom"
import type { AssignmentForm } from "./assignmentFormModel"

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

// The assignment details + core settings. Owns the create-only slug auto-fill
// and the opt-in due-date toggle, wired via props from the orchestrator.
export const DetailsSection = ({
  form,
  edit,
  org,
  classroom,
  slug,
  slugTouched,
  setSlugTouched,
  dueDateEnabled,
  setDueDateEnabled,
}: {
  form: AssignmentForm
  edit: boolean
  org?: string
  classroom?: string
  slug?: string
  slugTouched: boolean
  setSlugTouched: Dispatch<SetStateAction<boolean>>
  dueDateEnabled: boolean
  setDueDateEnabled: Dispatch<SetStateAction<boolean>>
}) => {
  const { t } = useTranslation()
  const tzShort = new Intl.DateTimeFormat(undefined, {
    timeZoneName: "short",
  })
    .formatToParts(new Date())
    .find((part) => part.type === "timeZoneName")?.value

  return (
    <Card bordered={false} className="w-full mb-6">
      <Card.Body>
        <h3 className="text-lg font-bold pb-4">
          {t("assignments.form.detailsSection")}
        </h3>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <form.Field name="name">
            {(field) => (
              <FormField
                htmlFor={field.name}
                required
                label={t("assignments.form.name")}
              >
                {({ id }) => (
                  <Input
                    id={id}
                    name={field.name}
                    required
                    aria-required="true"
                    placeholder={t("assignments.form.namePlaceholder")}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => {
                      field.handleChange(e.target.value)
                      if (!edit && !slugTouched) {
                        form.setFieldValue("slug", slugify(e.target.value))
                      }
                    }}
                  />
                )}
              </FormField>
            )}
          </form.Field>

          <form.Field name="slug">
            {(field) => {
              const slugError =
                !edit && field.state.meta.errors.length > 0
                  ? String(field.state.meta.errors[0])
                  : undefined
              return (
                <FormField
                  htmlFor={field.name}
                  required={!edit}
                  help={t(
                    edit
                      ? "assignments.form.slugEditHelp"
                      : "assignments.form.slugHelp",
                  )}
                  label={t("assignments.form.slug")}
                  error={slugError}
                >
                  {({ id, describedById, invalid }) => (
                    <Input
                      id={id}
                      name={field.name}
                      required={!edit}
                      aria-required={!edit}
                      // The slug is the assignment's repo-path identity;
                      // renaming isn't supported, so it's read-only on edit.
                      disabled={edit}
                      invalid={invalid}
                      aria-describedby={describedById}
                      placeholder={t("assignments.form.slugPlaceholder")}
                      value={field.state.value}
                      onBlur={(e) => {
                        // Normalize on blur so what the teacher sees is what's
                        // saved (the repo path segment). An emptied slug falls
                        // back to the name-derived default, so leaving it blank
                        // restores the auto slug.
                        const normalized = slugify(e.target.value)
                        field.handleChange(
                          normalized || slugify(form.state.values.name),
                        )
                        field.handleBlur()
                      }}
                      onChange={(e) => {
                        // Clearing the slug re-arms auto-fill from the name; any
                        // non-empty edit latches it off so a deliberate slug
                        // isn't clobbered by later name edits.
                        setSlugTouched(e.target.value.trim() !== "")
                        field.handleChange(e.target.value)
                      }}
                    />
                  )}
                </FormField>
              )
            }}
          </form.Field>
        </div>

        <form.Field name="description">
          {(field) => (
            <FormField
              htmlFor={field.name}
              className="mt-4"
              label={
                <>
                  {t("assignments.form.description")}
                  <span className="ms-1.5 font-normal text-base-content/60">
                    ({t("assignments.form.optional")})
                  </span>
                </>
              }
            >
              {({ id }) => (
                <Textarea
                  id={id}
                  name={field.name}
                  placeholder={t("assignments.form.descriptionPlaceholder")}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              )}
            </FormField>
          )}
        </form.Field>

        {/* An empty repo starts with no content, so the template picker is
            hidden while the toggle is on (the submit path clears the value
            too). */}
        <form.Subscribe selector={(state) => state.values.empty_repo}>
          {(emptyRepo) =>
            emptyRepo ? null : (
              <div className="mt-4">
                <form.Field name="template_repo">
                  {(field) => (
                    <TemplateField
                      field={field}
                      org={org}
                      classroom={classroom}
                      slug={slug}
                    />
                  )}
                </form.Field>
              </div>
            )
          }
        </form.Subscribe>

        <div className="divider my-2" />
        <h3 className="text-lg font-bold pb-2">
          {t("assignments.form.settingsSection")}
        </h3>

        <div className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2 sm:items-start">
          <div className="flex flex-col gap-4">
            <form.Field name="mode">
              {(field) => (
                <fieldset>
                  <legend className="label font-bold mb-2">
                    {t("assignments.form.type")}
                  </legend>
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    {(["individual", "group"] as const).map((value) => (
                      <label
                        key={value}
                        htmlFor={`${field.name}-${value}`}
                        className="label cursor-pointer gap-2 p-0"
                      >
                        <input
                          id={`${field.name}-${value}`}
                          type="radio"
                          className="radio"
                          name={field.name}
                          value={value}
                          checked={field.state.value === value}
                          onBlur={field.handleBlur}
                          onChange={() => field.handleChange(value)}
                        />
                        {t(
                          value === "individual"
                            ? "assignments.form.typeIndividual"
                            : "assignments.form.typeGroup",
                        )}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
            </form.Field>

            <form.Subscribe selector={(state) => state.values.mode}>
              {(modeValue) =>
                modeValue === "group" && (
                  <form.Field name="max_group_size">
                    {(field) => (
                      <div className="border-s-2 border-base-300 ps-4">
                        <FieldLabel
                          htmlFor={field.name}
                          label={t("assignments.form.maxGroupSize")}
                        />
                        <Input
                          id={field.name}
                          name={field.name}
                          type="number"
                          className="validator w-full sm:max-w-[8rem]"
                          placeholder="#"
                          min={GROUP_SIZE_MIN}
                          max={GROUP_SIZE_MAX}
                          step="1"
                          title={t("assignments.form.maxGroupSizeTitle", {
                            min: GROUP_SIZE_MIN,
                            max: GROUP_SIZE_MAX,
                          })}
                          value={
                            Number.isFinite(field.state.value)
                              ? field.state.value
                              : ""
                          }
                          onBlur={() => {
                            // Snap to a valid whole number on blur so the CLI
                            // never sees a non-integer or out-of-range size.
                            const raw = field.state.value
                            const next = Number.isFinite(raw)
                              ? Math.min(
                                  Math.max(Math.floor(raw), GROUP_SIZE_MIN),
                                  GROUP_SIZE_MAX,
                                )
                              : GROUP_SIZE_MIN
                            if (next !== raw) field.handleChange(next)
                            field.handleBlur()
                          }}
                          onChange={(e) =>
                            field.handleChange(e.target.valueAsNumber)
                          }
                        />
                      </div>
                    )}
                  </form.Field>
                )
              }
            </form.Subscribe>
          </div>

          <div className="flex flex-col gap-4">
            {/* An empty repo has no baseline commit, so the Feedback PR is
                structurally off: render the toggle locked-off (not hidden) so
                the trade-off stays visible. */}
            <form.Subscribe selector={(state) => state.values.empty_repo}>
              {(emptyRepo) => (
                <form.Field name="feedback_pr">
                  {(field) => (
                    <div
                      className={
                        emptyRepo ? "pointer-events-none opacity-50" : ""
                      }
                      aria-disabled={emptyRepo}
                    >
                      <ToggleRow
                        id={field.name}
                        checked={emptyRepo ? false : field.state.value}
                        onChange={(checked) => field.handleChange(checked)}
                        onBlur={field.handleBlur}
                        label={t("assignments.form.feedbackPr")}
                        help={
                          emptyRepo
                            ? t("assignments.form.feedbackPrEmptyRepoHelp")
                            : t("assignments.form.feedbackPrHelp")
                        }
                      />
                    </div>
                  )}
                </form.Field>
              )}
            </form.Subscribe>

            {/* Immutable after creation: locked in edit mode. */}
            <form.Field name="empty_repo">
              {(field) => (
                <div
                  className={edit ? "pointer-events-none opacity-50" : ""}
                  aria-disabled={edit}
                >
                  <ToggleRow
                    id={field.name}
                    checked={field.state.value}
                    onChange={(checked) => field.handleChange(checked)}
                    onBlur={field.handleBlur}
                    label={t("assignments.form.emptyRepo")}
                    help={
                      edit
                        ? `${t("assignments.form.emptyRepoHelp")} ${t("assignments.form.emptyRepoLocked")}`
                        : t("assignments.form.emptyRepoHelp")
                    }
                  />
                </div>
              )}
            </form.Field>

            <form.Field name="due_date">
              {(field) => (
                <div>
                  <ToggleRow
                    id={`${field.name}-enabled`}
                    checked={dueDateEnabled}
                    onChange={(checked) => {
                      setDueDateEnabled(checked)
                      if (!checked) field.handleChange("")
                    }}
                    label={t("assignments.form.setDueDate")}
                    help={t("assignments.form.setDueDateTip")}
                  />
                  {dueDateEnabled ? (
                    <div className="mt-2 ms-[3.75rem]">
                      <Input
                        id={field.name}
                        name={field.name}
                        type="datetime-local"
                        className="w-full sm:max-w-xs"
                        aria-label={t("assignments.form.dueDate", {
                          tz: tzShort,
                        })}
                        value={field.state.value}
                        onBlur={(e) => {
                          // Clearing the picker retires the due date: hide it
                          // and uncheck the box (value is already "").
                          if (!e.target.value) setDueDateEnabled(false)
                          field.handleBlur()
                        }}
                        onChange={(e) => field.handleChange(e.target.value)}
                      />
                      <p className="mt-1.5 text-sm text-base-content/70">
                        {t("assignments.form.dueDateTz", { tz: tzShort })}
                      </p>
                    </div>
                  ) : null}
                </div>
              )}
            </form.Field>
          </div>
        </div>
      </Card.Body>
      <FormErrors form={form} />
    </Card>
  )
}
