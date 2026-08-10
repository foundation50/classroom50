import { useTranslation } from "react-i18next"
import { Alert, FormField, Select, Textarea } from "@/components/ui"
import {
  parseSubmissionTags,
  validateSubmissionTags,
} from "@/util/submissionTags"
import type { AssignmentForm } from "../assignmentFormModel"
import { deriveFormShape } from "../formShape"
import { AdvancedSection } from "../AdvancedSection"
import AutogradingTestsPane from "../AutogradingTestsPane"
import type { SectionStatus } from "./sectionStatus"
import { SectionCard } from "./SectionCard"
import { AutogradingStateField } from "./AutogradingStateField"

// Autograding (IA overhaul U7): the tri-state selector plus, when the built-in
// autograder is selected, its sub-controls — Custom triggers (submission mode +
// milestone tags), Advanced settings (runtime/setup/allowed-files/threshold),
// and Declarative tests. Everything below the selector is gated on
// showBuiltInConfig so "empty" and "none" (both no-shim) show no grading config.
export function AutogradingSection({
  form,
  edit,
  status,
  org,
}: {
  form: AssignmentForm
  edit: boolean
  status: SectionStatus
  org?: string
}) {
  const { t } = useTranslation()

  return (
    <SectionCard
      title={t("assignments.form.autograding.label")}
      status={status}
    >
      <form.Subscribe
        selector={(state) => deriveFormShape(state.values).emptyRepo}
      >
        {(emptyRepo) => (
          <AutogradingStateField
            form={form}
            edit={edit}
            emptyRepo={emptyRepo}
          />
        )}
      </form.Subscribe>

      {/* Built-in sub-controls: Custom triggers, Advanced, and Declarative
          tests. Hidden for a bare repo (no shim) and for teacher-supplied CI
          ("none"); empty_repo always wins over a stale tri-state value via
          deriveFormShape. */}
      <form.Subscribe
        selector={(state) => deriveFormShape(state.values).showBuiltInConfig}
      >
        {(showBuiltInConfig) =>
          showBuiltInConfig ? (
            <div className="mt-6 flex flex-col gap-6">
              <CustomTriggers form={form} edit={edit} />
              <div className="divider my-0" />
              <AdvancedSection form={form} org={org} />
              <div className="divider my-0" />
              <AutogradingTestsPane form={form} />
            </div>
          ) : null
        }
      </form.Subscribe>
    </SectionCard>
  )
}

// Custom triggers: submission mode (every-push vs tag) and milestone tags. Both
// only matter when a shim exists, so the caller gates them on showBuiltInConfig.
// On edit a change only affects new accepts — the retrofit warning is preserved.
function CustomTriggers({
  form,
  edit,
}: {
  form: AssignmentForm
  edit: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-4">
      <h4 className="font-bold">
        {t("assignments.form.customTriggersHeading")}
      </h4>

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
                    field.handleChange(
                      e.target.value as typeof field.state.value,
                    )
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
            {edit ? (
              <form.Subscribe
                selector={(state) => state.values.submission_mode}
              >
                {(mode) =>
                  mode !==
                  (form.options.defaultValues?.submission_mode ??
                    "every-push") ? (
                    <Alert
                      tone="warning"
                      role="status"
                      className="mt-2 text-sm"
                    >
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
              <form.Subscribe
                selector={(state) => state.values.submission_tags}
              >
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
    </div>
  )
}
