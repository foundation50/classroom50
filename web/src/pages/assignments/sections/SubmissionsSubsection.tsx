import { useTranslation } from "react-i18next"
import { Alert, FormField, Select, Textarea } from "@/components/ui"
import {
  parseSubmissionTags,
  validateSubmissionTags,
} from "@/util/submissionTags"
import type { AssignmentForm } from "../assignmentFormModel"

// Submissions: the single source of truth for what counts as a submission.
//
// The submission DEFINITION (branch = every default-branch push except the
// baseline; tag = on submit/milestone tags only) is a property of the
// assignment itself, so it renders regardless of grading choice or repository
// source (R3). Autograding and the Submissions page both CONSUME this
// definition rather than owning it.
//
// The milestone-tags field is different: those patterns are baked into the
// autograde shim's trigger (union with submit/*), so they only matter when a
// built-in shim exists. The caller gates that field on showBuiltInConfig
// (KTD5); the shim-retrofit edit warning on the mode field is likewise only
// meaningful with a shim, so it takes showBuiltInConfig too.
export function SubmissionsSubsection({
  form,
  edit,
  showBuiltInConfig,
}: {
  form: AssignmentForm
  edit: boolean
  showBuiltInConfig: boolean
}) {
  return (
    <div className="flex flex-col gap-4">
      <SubmissionModeField
        form={form}
        edit={edit}
        showBuiltInConfig={showBuiltInConfig}
      />
      {showBuiltInConfig ? (
        <SubmissionTagsField form={form} edit={edit} />
      ) : null}
    </div>
  )
}

// The submission definition: branch (every default-branch push) vs tag (on
// submit only). Always visible. The edit warning is a shim-retrofit notice, so
// it only shows when a built-in shim exists (showBuiltInConfig).
function SubmissionModeField({
  form,
  edit,
  showBuiltInConfig,
}: {
  form: AssignmentForm
  edit: boolean
  showBuiltInConfig: boolean
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
          {edit && showBuiltInConfig ? (
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
