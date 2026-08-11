import { useTranslation } from "react-i18next"
import { Alert, FormField, Select, Textarea } from "@/components/ui"
import {
  parseSubmissionTags,
  validateSubmissionTags,
} from "@/util/submissionTags"
import type { AssignmentForm } from "../assignmentFormModel"

// Submissions: the single source of truth for what counts as a submission.
//
// The whole submission definition — the mode (branch = every default-branch
// push except the baseline; tag = on submit/milestone tags only) AND the
// milestone tag patterns — is how the APP identifies submissions on the
// submissions page. That is independent of the grading choice and of the repo
// shape (empty, teacher-CI, or built-in shim): detection reads the repo's
// commits/tags directly, with or without an autograder. So both controls always
// render.
//
// showBuiltInConfig only governs the shim-RETROFIT edit warnings: those advise
// re-pulling existing repos' shims, which only exist for a built-in autograder.
// With no shim there is nothing to retrofit, so the warnings are suppressed —
// but the fields themselves stay visible and are persisted (the wire permits
// submission_mode/submission_tags on every repo shape; they act as the
// detection definition when no shim triggers on them).
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
        showRetrofitWarning={showBuiltInConfig}
      />
      <SubmissionTagsField
        form={form}
        edit={edit}
        showRetrofitWarning={showBuiltInConfig}
      />
    </div>
  )
}

// The submission definition: branch (every default-branch push) vs tag (on
// submit only). Always visible. The retrofit edit warning only shows when a
// built-in shim exists (there is a shim to update).
function SubmissionModeField({
  form,
  edit,
  showRetrofitWarning,
}: {
  form: AssignmentForm
  edit: boolean
  showRetrofitWarning: boolean
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
          {edit && showRetrofitWarning ? (
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
  showRetrofitWarning,
}: {
  form: AssignmentForm
  edit: boolean
  showRetrofitWarning: boolean
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
                //   3. broad-glob caution — advisory (always shown).
                //   4. edit-retrofit warning — advisory, shim-only.
                const parsed = parseSubmissionTags(tags)
                const hasComma = (tags ?? "").includes(",")
                const validationError = validateSubmissionTags(parsed)
                const broad = parsed.some(
                  (p) => p.includes("*") || p.includes("+"),
                )
                const changed =
                  edit &&
                  showRetrofitWarning &&
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
