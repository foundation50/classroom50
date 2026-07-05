import useGetClasses from "@/hooks/useGetClasses"
import { useForm } from "@tanstack/react-form"
import { useParams } from "@tanstack/react-router"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  DEFAULT_SECRET_LENGTH,
  SECRET_PATTERN_DESCRIPTION,
  generateSecret,
  isValidSecret,
} from "@/util/secret"
import { slugify } from "@/util/slug"

export type CreateClassroomFormValues = {
  name: string
  slug: string
  term: string
  // Opt-in: when true, published resources are served under an unguessable
  // capability-URL secret path segment. Off by default.
  protectPages: boolean
  // Capability-URL secret. Empty when protectPages is false; a generated
  // (editable) value when true. Validated to `[a-z0-9]{4,64}` on submit.
  secret: string
}

type CreateClassroomFormProps = {
  defaultValues?: Partial<CreateClassroomFormValues>
  // Returns the submit's settling promise (or void) so the form can await the
  // real write and latch its loading state only on success.
  onSubmit: (values: CreateClassroomFormValues) => void | Promise<unknown>
}

const CreateClassroomForm = ({
  defaultValues,
  onSubmit,
}: CreateClassroomFormProps) => {
  const { t } = useTranslation()
  const { org = "" } = useParams({ strict: false })
  const { classes } = useGetClasses(org)
  const [submitted, setSubmitted] = useState(false)

  const form = useForm({
    defaultValues: {
      name: defaultValues?.name ?? "",
      slug: defaultValues?.slug ?? "",
      term: defaultValues?.slug ?? "",
      protectPages: defaultValues?.protectPages ?? false,
      secret: defaultValues?.secret ?? "",
    } satisfies CreateClassroomFormValues,
    validators: {
      onSubmit: ({ value }) => {
        const errors: Partial<Record<keyof CreateClassroomFormValues, string>> =
          {}
        if (!value.name.trim()) {
          errors.name = t("validation.classroomNameRequired")
        }

        if (!value.slug.trim()) {
          errors.slug = t("validation.classroomSlugRequired")
        }

        if (classes.find((cl) => cl.path === value.slug.trim())) {
          errors.slug = t("validation.classroomSlugTaken")
        }

        // Only validate the secret when protection is on; a disabled toggle
        // leaves it empty (unprotected, the default).
        if (value.protectPages && !isValidSecret(value.secret.trim())) {
          errors.secret = t("classes.form.secretInvalid", {
            description: SECRET_PATTERN_DESCRIPTION,
          })
        }

        return Object.keys(errors).length > 0
          ? {
              fields: errors,
            }
          : undefined
      },
    },
    onSubmit: async ({ value }) => {
      // Latch `submitted` only on success: a rejected create skips it (page's
      // mutation onError toasts), so the button re-enables for a retry instead
      // of sticking on "Creating...".
      await onSubmit({
        name: value.name.trim(),
        slug: slugify(value.slug),
        term: value.term.trim(),
        protectPages: value.protectPages,
        // Pass the secret only when protection is on; otherwise empty so the
        // classroom stays at the plain Pages path.
        secret: value.protectPages ? value.secret.trim() : "",
      })
      setSubmitted(true)
    },
  })
  return (
    <form
      className="card bg-base-100 w-full shadow-sm"
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        form.handleSubmit()
      }}
    >
      <div className="card-body">
        <h3 className="text-lg font-bold pb-4">
          {t("classes.form.basicInfo")}
        </h3>

        <form.Field name="name">
          {(field) => (
            <>
              <label htmlFor={field.name} className="label font-bold">
                {t("classes.form.name")}
                <span className="text-error">*</span>
              </label>

              <input
                id={field.name}
                name={field.name}
                type="text"
                required
                aria-required="true"
                aria-invalid={field.state.meta.errors.length > 0}
                aria-describedby={
                  field.state.meta.errors.length > 0
                    ? `${field.name}-error`
                    : undefined
                }
                className="input w-full mb-4"
                placeholder={t("classes.form.namePlaceholder")}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => {
                  field.handleChange(e.target.value)
                  form.setFieldValue("slug", slugify(e.target.value))
                }}
              />

              {field.state.meta.errors.length > 0 && (
                <p
                  id={`${field.name}-error`}
                  className="text-error text-sm mb-4"
                  role="alert"
                >
                  {field.state.meta.errors[0]}
                </p>
              )}
            </>
          )}
        </form.Field>

        <form.Field name="slug">
          {(field) => (
            <>
              <label htmlFor={field.name} className="label font-bold">
                {t("classes.form.slug")}
                <span className="text-error">*</span>
              </label>

              <input
                id={field.name}
                name={field.name}
                type="text"
                required
                aria-required="true"
                aria-invalid={field.state.meta.errors.length > 0}
                aria-describedby={
                  field.state.meta.errors.length > 0
                    ? `${field.name}-error`
                    : undefined
                }
                className="input w-full mb-4"
                placeholder={t("classes.form.slugPlaceholder")}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />

              {field.state.meta.errors.length > 0 && (
                <p
                  id={`${field.name}-error`}
                  className="text-error text-sm mb-4"
                  role="alert"
                >
                  {field.state.meta.errors[0]}
                </p>
              )}
            </>
          )}
        </form.Field>

        <form.Field name="term">
          {(field) => (
            <>
              <label htmlFor={field.name} className="label font-bold">
                {t("classes.form.term")}
              </label>

              <input
                id={field.name}
                name={field.name}
                type="text"
                className="input w-full mb-4"
                placeholder={t("classes.form.termPlaceholder")}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />

              {field.state.meta.errors.length > 0 && (
                <p className="text-error text-sm mb-4" role="alert">
                  {field.state.meta.errors[0]}
                </p>
              )}
            </>
          )}
        </form.Field>

        <form.Field name="protectPages">
          {(field) => (
            <div className="mt-2 rounded-box border border-base-200 p-4">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="toggle toggle-primary mt-0.5"
                  checked={field.state.value}
                  onChange={(e) => {
                    const on = e.target.checked
                    field.handleChange(on)
                    // Generate a candidate the first time protection is enabled
                    // (and the field is empty) so the teacher sees a ready-to-use
                    // key to accept or replace. Turning it off clears the secret
                    // so an unprotected classroom never carries one.
                    if (on) {
                      if (!form.getFieldValue("secret")) {
                        form.setFieldValue(
                          "secret",
                          generateSecret(DEFAULT_SECRET_LENGTH),
                        )
                      }
                    } else {
                      form.setFieldValue("secret", "")
                    }
                  }}
                />
                <span>
                  <span className="font-bold">
                    {t("classes.form.protectPagesLabel")}
                  </span>
                  <span className="block text-sm text-base-content/70">
                    {t("classes.form.protectPagesHint")}
                  </span>
                </span>
              </label>

              <form.Subscribe selector={(state) => state.values.protectPages}>
                {(protect) =>
                  protect ? (
                    <form.Field name="secret">
                      {(secretField) => (
                        <div className="mt-4">
                          <label
                            htmlFor={secretField.name}
                            className="label font-bold"
                          >
                            {t("classes.form.accessKey")}
                          </label>
                          <div className="flex gap-2">
                            <input
                              id={secretField.name}
                              name={secretField.name}
                              type="text"
                              className="input w-full font-mono"
                              placeholder={t(
                                "classes.form.accessKeyPlaceholder",
                              )}
                              value={secretField.state.value}
                              onBlur={secretField.handleBlur}
                              onChange={(e) =>
                                secretField.handleChange(e.target.value)
                              }
                            />
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() =>
                                secretField.handleChange(
                                  generateSecret(DEFAULT_SECRET_LENGTH),
                                )
                              }
                            >
                              {t("classes.form.regenerate")}
                            </button>
                          </div>
                          <p className="mt-1 text-xs text-base-content/70">
                            {t("classes.form.accessKeyHelp", {
                              description: SECRET_PATTERN_DESCRIPTION,
                            })}
                          </p>
                          {secretField.state.meta.errors.length > 0 && (
                            <p className="text-error text-sm mt-1" role="alert">
                              {secretField.state.meta.errors[0]}
                            </p>
                          )}
                        </div>
                      )}
                    </form.Field>
                  ) : null
                }
              </form.Subscribe>
            </div>
          )}
        </form.Field>

        <div className="card-actions justify-end p-2">
          <form.Subscribe
            selector={(state) => [state.canSubmit, state.isSubmitting]}
          >
            {([canSubmit, isSubmitting]) => {
              // Hold the loading state through post-create navigation so the
              // button never reverts to a bare disabled state.
              const busy = isSubmitting || submitted
              return (
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!canSubmit || busy}
                >
                  {busy ? (
                    <>
                      <span
                        className="loading loading-spinner loading-sm"
                        aria-hidden="true"
                      />
                      {t("classes.form.creating")}
                    </>
                  ) : (
                    t("classes.form.createButton")
                  )}
                </button>
              )
            }}
          </form.Subscribe>
        </div>
      </div>
    </form>
  )
}

export default CreateClassroomForm
