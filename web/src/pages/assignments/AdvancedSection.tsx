import { useTranslation } from "react-i18next"
import { AlertTriangle } from "lucide-react"
import { Input, Textarea } from "@/components/ui"
import { parseAllowedFiles } from "@/util/allowedFiles"
import { RUNTIME_LANGUAGES } from "@/util/runtime"
import {
  FieldLabel,
  HelpTooltip,
  RunnerField,
  LanguageVersionField,
  ContainerFields,
  AptField,
} from "./AdvancedRuntimeFields"
import { normalizeOnBlur } from "./formFieldHelpers"
import { PASS_THRESHOLD_MAX, PASS_THRESHOLD_MIN } from "@/types/classroom"
import type { AssignmentForm } from "./assignmentFormModel"

// The collapsible Advanced Settings pane. runtime_env gates which runtime
// fields render (container image/user vs apt) so the mutually exclusive wire
// shapes stay unrepresentable rather than merely validated-against.
export const AdvancedSection = ({
  form,
  org,
}: {
  form: AssignmentForm
  org?: string
}) => {
  const { t } = useTranslation()
  return (
    <details className="group">
      <summary className="cursor-pointer text-lg font-bold marker:content-none flex items-center gap-2">
        <span className="transition-transform group-open:rotate-90">▶</span>
        {t("assignments.form.advanced")}
      </summary>

      <p className="label pt-2 pb-4">{t("assignments.form.advancedHelp")}</p>

      <form.Field name="runtime_env">
        {(field) => (
          <fieldset className="mb-4">
            <legend className="label font-bold mb-2">
              {t("assignments.form.runtime.envLegend")}
            </legend>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <label
                htmlFor={`${field.name}-hosted`}
                className="label cursor-pointer gap-2 p-0"
              >
                <input
                  id={`${field.name}-hosted`}
                  type="radio"
                  className="radio"
                  name={field.name}
                  value="hosted"
                  checked={field.state.value === "hosted"}
                  onChange={() => field.handleChange("hosted")}
                />
                {t("assignments.form.runtime.envHosted")}
              </label>
              <label
                htmlFor={`${field.name}-container`}
                className="label cursor-pointer gap-2 p-0"
              >
                <input
                  id={`${field.name}-container`}
                  type="radio"
                  className="radio"
                  name={field.name}
                  value="container"
                  checked={field.state.value === "container"}
                  onChange={() => field.handleChange("container")}
                />
                {t("assignments.form.runtime.envContainer")}
              </label>
            </div>
            <p className="mt-1.5 text-sm text-base-content/70">
              {field.state.value === "container"
                ? t("assignments.form.runtime.envContainerHelp")
                : t("assignments.form.runtime.envHostedHelp")}
            </p>
          </fieldset>
        )}
      </form.Field>

      <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
        <form.Field name="runs_on">
          {(field) => <RunnerField field={field} org={org} />}
        </form.Field>
      </div>

      <form.Subscribe selector={(state) => state.values.runtime_env}>
        {(runtimeEnv) =>
          runtimeEnv === "container" ? <ContainerFields form={form} /> : null
        }
      </form.Subscribe>

      <div className="mt-4">
        <FieldLabel
          label={t("assignments.form.runtime.languagesHeading")}
          help={t("assignments.form.runtime.languagesTip")}
        />
        <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
          {RUNTIME_LANGUAGES.map((language) => (
            <LanguageVersionField
              key={language}
              form={form}
              language={language}
            />
          ))}
        </div>
      </div>

      <form.Subscribe selector={(state) => state.values.runtime_env}>
        {(runtimeEnv) =>
          runtimeEnv === "container" ? null : <AptField form={form} />
        }
      </form.Subscribe>

      <form.Field name="setup_command">
        {(field) => (
          <div className="mt-4">
            <FieldLabel
              htmlFor={field.name}
              label={t("assignments.form.setupCommand")}
              help={t("assignments.form.setupCommandTip")}
            />
            <Input
              id={field.name}
              name={field.name}
              placeholder={t("assignments.form.setupCommandPlaceholder")}
              value={field.state.value}
              onBlur={normalizeOnBlur(field)}
              onChange={(e) => field.handleChange(e.target.value)}
            />
          </div>
        )}
      </form.Field>

      <form.Field name="allowed_files">
        {(field) => {
          const patterns = parseAllowedFiles(field.state.value)
          const error = field.state.meta.errors[0] as string | undefined
          return (
            <div className="mt-4">
              <FieldLabel
                htmlFor={field.name}
                label={t("assignments.form.allowedFiles")}
                help={t("assignments.form.allowedFilesTip", {
                  gitignore: ".gitignore",
                  bang: "!",
                  star: "*",
                  example: "!hello.py",
                  result: "hello.py",
                })}
              />
              <Textarea
                id={field.name}
                name={field.name}
                className="font-mono"
                rows={4}
                spellCheck={false}
                placeholder={"*\n!hello.py"}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
              {error ? (
                <p
                  role="alert"
                  className="mt-1.5 flex items-center gap-1.5 text-sm text-error"
                >
                  <AlertTriangle
                    aria-hidden="true"
                    className="size-4 shrink-0"
                  />
                  {error}
                </p>
              ) : (
                patterns.length > 0 && (
                  <p className="mt-1.5 text-xs text-base-content/70">
                    {t("assignments.form.patternCount", {
                      count: patterns.length,
                    })}
                  </p>
                )
              )}
            </div>
          )
        }}
      </form.Field>

      <form.Field name="pass_threshold_enabled">
        {(toggle) => (
          <div className="mt-4">
            <div className="flex items-center gap-1.5">
              <label className="label cursor-pointer justify-start gap-3 p-0 font-bold">
                <input
                  type="checkbox"
                  className="toggle toggle-sm"
                  checked={toggle.state.value}
                  onChange={(e) => toggle.handleChange(e.target.checked)}
                />
                {t("assignments.form.passThresholdToggle")}
              </label>
              <HelpTooltip help={t("assignments.form.passThresholdTip")} />
            </div>

            {toggle.state.value && (
              <form.Field name="pass_threshold">
                {(field) => {
                  const error = field.state.meta.errors[0] as string | undefined
                  return (
                    <div className="mt-3">
                      <div className="flex items-center gap-2">
                        <Input
                          id={field.name}
                          name={field.name}
                          type="number"
                          inputMode="numeric"
                          min={PASS_THRESHOLD_MIN}
                          max={PASS_THRESHOLD_MAX}
                          step={1}
                          className="w-28"
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) =>
                            field.handleChange(Number(e.target.value))
                          }
                        />
                        <span className="text-sm text-base-content/70">
                          {t("assignments.form.passThresholdSuffix")}
                        </span>
                      </div>
                      {error ? (
                        <p
                          role="alert"
                          className="mt-1.5 flex items-center gap-1.5 text-sm text-error"
                        >
                          <AlertTriangle
                            aria-hidden="true"
                            className="size-4 shrink-0"
                          />
                          {error}
                        </p>
                      ) : null}
                    </div>
                  )
                }}
              </form.Field>
            )}
          </div>
        )}
      </form.Field>
    </details>
  )
}
