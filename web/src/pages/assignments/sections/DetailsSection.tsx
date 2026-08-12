import { useTranslation } from "react-i18next"
import { nextAvailableSlug, slugify } from "@/util/slug"
import { FormField, Input, Textarea } from "@/components/ui"
import { GROUP_SIZE_MAX, GROUP_SIZE_MIN } from "@/types/classroom"
import { FieldLabel } from "../AdvancedRuntimeFields"
import type { AssignmentForm } from "../assignmentFormModel"
import { deriveFormShape } from "../formShape"
import { SectionCard } from "./SectionCard"

// Assignment Details (IA overhaul U4): the assignment's identity — name, slug,
// description, and type. Repository source, autograding, features, and schedule
// live in their own sections. Owns the create-only slug auto-fill and the
// edit-locked slug; slug renaming isn't supported (it's the repo-path identity).
export function DetailsSection({
  form,
  edit,
  onReset,
  slugTouched,
  setSlugTouched,
  takenSlugs,
}: {
  form: AssignmentForm
  edit: boolean
  onReset?: () => void
  slugTouched: boolean
  setSlugTouched: (touched: boolean) => void
  // Existing assignment slugs, so the create-mode auto-fill can pick a slug
  // that's already unique instead of surfacing a conflict only at submit.
  takenSlugs?: string[]
}) {
  const { t } = useTranslation()

  return (
    <SectionCard title={t("assignments.form.detailsSection")} onReset={onReset}>
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
                      // Auto-fill a slug that's already unique in this
                      // classroom, so a collision doesn't wait until submit.
                      form.setFieldValue(
                        "slug",
                        nextAvailableSlug(slugify(e.target.value), takenSlugs ?? []),
                      )
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
                    // The slug is the assignment's repo-path identity; renaming
                    // isn't supported, so it's read-only on edit.
                    disabled={edit}
                    invalid={invalid}
                    aria-describedby={describedById}
                    placeholder={t("assignments.form.slugPlaceholder")}
                    value={field.state.value}
                    onBlur={(e) => {
                      // Normalize on blur so what the teacher sees is what's
                      // saved (the repo path segment). An emptied slug falls
                      // back to a unique name-derived default, so leaving it
                      // blank restores the auto slug.
                      const normalized = slugify(e.target.value)
                      field.handleChange(
                        normalized ||
                          nextAvailableSlug(
                            slugify(form.state.values.name),
                            takenSlugs ?? [],
                          ),
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

      <form.Field name="mode">
        {(field) => (
          <fieldset className="mt-4">
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

      {/* Max group size sits directly under Assignment type (feedback: related
          settings grouped together). Shows only for a group assignment. */}
      <form.Subscribe
        selector={(state) => deriveFormShape(state.values).showGroupSize}
      >
        {(showGroupSize) =>
          showGroupSize ? (
            <form.Field name="max_group_size">
              {(field) => (
                <div className="mt-4 border-s-2 border-base-300 ps-4">
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
                      // Snap to a valid whole number on blur so the CLI never
                      // sees a non-integer or out-of-range size.
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
                    onChange={(e) => field.handleChange(e.target.valueAsNumber)}
                  />
                </div>
              )}
            </form.Field>
          ) : null
        }
      </form.Subscribe>
    </SectionCard>
  )
}
