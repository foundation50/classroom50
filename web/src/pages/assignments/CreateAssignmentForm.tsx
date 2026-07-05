import { useForm } from "@tanstack/react-form"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { slugify } from "@/util/slug"
import { AlertTriangle } from "lucide-react"
import AutogradingTestsPane from "./AutogradingTestsPane"
import type { AssignmentTestDraft } from "@/util/assignmentTests"
import {
  testToDraft,
  validateTestDrafts,
  isSetupTest,
} from "@/util/assignmentTests"
import {
  parseAllowedFiles,
  allowedFilesToText,
  validateAllowedFiles,
} from "@/util/allowedFiles"
import { parseRunnerLabels } from "@/util/runners"
import {
  RUNTIME_LANGUAGES,
  type RuntimeLanguage,
  aptPackagesToText,
  isNonUbuntuHostedLabel,
  parseAptPackages,
  validateAptPackages,
  validateContainerImage,
  validateContainerUser,
  validateLanguageVersion,
} from "@/util/runtime"
import { TemplateField } from "./TemplateField"
import {
  FieldLabel,
  HelpTooltip,
  RunnerField,
  LanguageVersionField,
  ContainerFields,
  AptField,
} from "./AdvancedRuntimeFields"
import {
  normalizeOnBlur,
  toDatetimeLocalValue,
  sevenDaysFromNow,
  utcIsoToDatetimeLocalValue,
} from "./formFieldHelpers"
import type { Assignment } from "@/types/classroom"
import { GROUP_SIZE_MAX, GROUP_SIZE_MIN } from "@/types/classroom"
import {
  DEFAULT_PASS_THRESHOLD,
  PASS_THRESHOLD_MAX,
  PASS_THRESHOLD_MIN,
} from "@/types/classroom"

// Which runtime environment the Advanced Settings form is configuring. A UI-
// only discriminator (not a wire field): "hosted" = a GitHub Actions runner
// (runs-on + apt packages), "container" = a Docker image (image + user). The
// two are mutually exclusive on the wire, so the form picks one and clears the
// other's fields, making the runner's container-vs-(runs-on/apt) conflicts
// unrepresentable rather than merely validated-against.
export type RuntimeEnv = "hosted" | "container"

export type CreateAssignmentFormValues = {
  name: string
  // URL/repo slug for the assignment (edited on create only).
  slug: string
  description: string
  mode: "group" | "individual"
  template_repo: string
  due_date: string
  max_group_size: number
  feedback_pr: boolean
  // UI-only: which runtime environment the teacher is configuring. Selects
  // which fields render and get written; never sent to the wire. "hosted" uses
  // a GitHub Actions runner (runs-on + apt); "container" grades inside a Docker
  // image (image + user). Deriving the two apart in the UI structurally
  // prevents the container-vs-(runs-on/apt) conflicts the runner rejects.
  runtime_env: RuntimeEnv
  runs_on: string
  container_image: string
  container_user: string
  runtime_python: string
  runtime_node: string
  runtime_java: string
  runtime_go: string
  // Raw text (comma/space-separated); parsed to string[] on save.
  runtime_apt: string
  setup_command: string
  // Raw textarea text; parsed to string[] on save, joined back on read.
  allowed_files: string
  // Opt-in passing threshold (off by default). When enabled, pass_threshold is
  // an integer percentage 0–100; when disabled, no passing concept is written.
  pass_threshold_enabled: boolean
  pass_threshold: number
  tests: AssignmentTestDraft[]
}

// Concrete form-instance type shared with child panes (AutogradingTestsPane,
// FormErrors) so their `form` prop is typed without restating useForm's
// generics. Derived from the hook below so the generics always match.
export type AssignmentForm = ReturnType<typeof useAssignmentForm>

const useAssignmentForm = (
  defaultValues: Partial<CreateAssignmentFormValues> | undefined,
  onSubmit: (values: CreateAssignmentFormValues) => void | Promise<void>,
  t: TFunction,
  // Create-only: slug uniqueness is not validated in edit mode (no rename).
  slugContext?: { takenSlugs?: string[]; edit?: boolean },
) =>
  useForm({
    defaultValues: {
      name: defaultValues?.name || "",
      slug: defaultValues?.slug || "",
      description: defaultValues?.description || "",
      mode: defaultValues?.mode || "individual",
      template_repo: defaultValues?.template_repo || "",
      due_date:
        utcIsoToDatetimeLocalValue(defaultValues?.due_date) ||
        toDatetimeLocalValue(sevenDaysFromNow()),
      max_group_size: defaultValues?.max_group_size || 2,
      feedback_pr: defaultValues?.feedback_pr ?? true,
      runtime_env: defaultValues?.runtime_env || "hosted",
      runs_on: defaultValues?.runs_on || "",
      container_image: defaultValues?.container_image || "",
      container_user: defaultValues?.container_user || "",
      runtime_python: defaultValues?.runtime_python || "",
      runtime_node: defaultValues?.runtime_node || "",
      runtime_java: defaultValues?.runtime_java || "",
      runtime_go: defaultValues?.runtime_go || "",
      runtime_apt: defaultValues?.runtime_apt || "",
      setup_command: defaultValues?.setup_command || "",
      allowed_files: defaultValues?.allowed_files || "",
      pass_threshold_enabled: defaultValues?.pass_threshold_enabled ?? false,
      pass_threshold: defaultValues?.pass_threshold ?? DEFAULT_PASS_THRESHOLD,
      tests: defaultValues?.tests || [],
    } satisfies CreateAssignmentFormValues,
    validators: {
      onSubmit: ({ value }) => {
        const errors: Record<string, string> = {}
        if (!value.name.trim()) {
          errors.name = t("assignments.form.validation.nameRequired")
        }
        // Edit mode doesn't rename, so slug is only validated on create.
        if (!slugContext?.edit) {
          const slug = slugify(value.slug)
          if (!slug) {
            errors.slug = t("assignments.form.validation.slugRequired")
          } else if (
            (slugContext?.takenSlugs ?? []).some(
              (s) => s.trim().toLowerCase() === slug.toLowerCase(),
            )
          ) {
            // Case-insensitive collision (slugs become repo path segments);
            // write path re-checks authoritatively (nextAvailableSlug).
            errors.slug = t("validation.assignmentSlugTaken", { slug })
          }
        }
        if (!Number(value.max_group_size)) {
          errors.max_group_size = t(
            "assignments.form.validation.maxGroupSizeInvalid",
          )
        } else if (
          value.mode === "group" &&
          (!Number.isInteger(Number(value.max_group_size)) ||
            Number(value.max_group_size) < GROUP_SIZE_MIN ||
            Number(value.max_group_size) > GROUP_SIZE_MAX)
        ) {
          // Mirror buildAssignmentEntry: CLI schema needs a whole number in
          // [MIN, MAX] or assignments.json becomes unparseable.
          errors.max_group_size = t("validation.groupSizeRange", {
            min: GROUP_SIZE_MIN,
            max: GROUP_SIZE_MAX,
          })
        }

        // Mirror gh-teacher's write-time validation so a bad test is caught in
        // the form, not by a failed commit or an unparseable file.
        Object.assign(errors, validateTestDrafts(value.tests))

        // Mirror the CLI's cap/shape rules so a bad value can't reach the file.
        const allowedFilesError = validateAllowedFiles(
          parseAllowedFiles(value.allowed_files),
        )
        if (allowedFilesError) {
          errors.allowed_files = allowedFilesError
        }

        // Only validated when the teacher enabled it. Integer percentage in
        // [0, 100] (mirrors the CLI schema bounds).
        if (value.pass_threshold_enabled) {
          const threshold = Number(value.pass_threshold)
          if (
            !Number.isInteger(threshold) ||
            threshold < PASS_THRESHOLD_MIN ||
            threshold > PASS_THRESHOLD_MAX
          ) {
            errors.pass_threshold = t(
              "assignments.form.validation.passThresholdRange",
              { min: PASS_THRESHOLD_MIN, max: PASS_THRESHOLD_MAX },
            )
          }
        }

        // Language toolchain versions + apt packages, mirroring the CLI's
        // ValidateRuntime patterns so a bad value is caught before the commit.
        const languageFields: Record<RuntimeLanguage, string> = {
          python: value.runtime_python,
          node: value.runtime_node,
          java: value.runtime_java,
          go: value.runtime_go,
        }
        for (const language of RUNTIME_LANGUAGES) {
          const error = validateLanguageVersion(languageFields[language])
          if (error) {
            errors[`runtime_${language}`] = error
          }
        }
        // apt only applies to the hosted runtime; container mode clears it on
        // submit and hides the input, so only validate it there. The
        // container-vs-apt conflict is now structurally impossible (the two
        // live in different, mutually exclusive modes), so no cross-check.
        if (value.runtime_env !== "container") {
          const aptError = validateAptPackages(
            parseAptPackages(value.runtime_apt),
          )
          if (aptError) {
            errors.runtime_apt = aptError
          }
        }

        // A container runs on Ubuntu hosts only, so a macOS/Windows runner
        // label can't be combined with a Docker image (mirrors the CLI). A
        // custom/self-hosted or Ubuntu label is fine.
        if (value.runtime_env === "container" && value.container_image.trim()) {
          const badLabel = parseRunnerLabels(value.runs_on).find(
            isNonUbuntuHostedLabel,
          )
          if (badLabel) {
            errors.runs_on = t(
              "assignments.form.runtime.runnerContainerError",
              {
                label: badLabel,
              },
            )
          }
        }

        // Container image/user shape, mirroring the CLI's ValidateContainer, so
        // an injection-shaped value is caught inline before the write path
        // (which enforces the same gate) rejects it.
        if (value.runtime_env === "container") {
          const imageError = validateContainerImage(value.container_image)
          if (imageError) {
            errors.container_image = imageError
          }
          const userError = validateContainerUser(value.container_user)
          if (userError) {
            errors.container_user = userError
          }
        }

        return Object.keys(errors).length > 0 ? { fields: errors } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      // Clear the fields that don't belong to the selected runtime environment
      // so a hidden, stale value from the other mode can't reach the wire.
      // apt is hosted-only (a container image owns its packages — the CLI
      // forbids container+apt), and container image/user apply only in
      // container mode. runs-on and the language versions apply to BOTH modes
      // (a container job can target a specific runner; setup-* runs inside a
      // container), so they always pass through.
      const isContainer = value.runtime_env === "container"
      await onSubmit({
        name: value.name.trim(),
        slug: slugify(value.slug),
        description: value.description.trim(),
        mode: value.mode,
        template_repo: value.template_repo.trim(),
        due_date: value.due_date.trim(),
        max_group_size: value.max_group_size,
        feedback_pr: value.feedback_pr,
        runtime_env: value.runtime_env,
        runs_on: value.runs_on.trim(),
        container_image: isContainer ? value.container_image.trim() : "",
        container_user: isContainer ? value.container_user.trim() : "",
        runtime_python: value.runtime_python.trim(),
        runtime_node: value.runtime_node.trim(),
        runtime_java: value.runtime_java.trim(),
        runtime_go: value.runtime_go.trim(),
        runtime_apt: isContainer ? "" : value.runtime_apt.trim(),
        setup_command: value.setup_command.trim(),
        allowed_files: value.allowed_files,
        pass_threshold_enabled: value.pass_threshold_enabled,
        pass_threshold: Number(value.pass_threshold),
        tests: value.tests,
      })
    },
  })

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
  // Existing assignment slugs, for the create-mode uniqueness check.
  takenSlugs?: string[]
}
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

// Map a stored classroom50/assignments/v1 entry back into form values:
// template as `owner/repo`, due as datetime-local, runtime split into
// runner/container fields, and the leading 0-point "setup" test lifted back
// into the setup command.
export const assignmentToFormValues = (
  assignment: Assignment,
): Partial<CreateAssignmentFormValues> => {
  const allTests = (assignment.tests ?? []).map(testToDraft)
  // Lift the setup command only from a leading setup test (isSetupTest), never a
  // later or graded one, so a round-trip can't swallow a user-authored test.
  // (Also guards pre-reservation assignments.)
  const head = allTests[0]
  const setupIsLeading = head !== undefined && isSetupTest(head)
  const setupCommand = setupIsLeading ? head.run : ""
  const tests = setupIsLeading ? allTests.slice(1) : allTests

  return {
    name: assignment.name,
    description: assignment.description ?? "",
    mode: assignment.mode === "group" ? "group" : "individual",
    template_repo: assignment.template
      ? `${assignment.template.owner}/${assignment.template.repo}`
      : "",
    due_date: utcIsoToDatetimeLocalValue(assignment.due),
    max_group_size: assignment.max_group_size ?? 2,
    feedback_pr: assignment.feedback_pr ?? true,
    // A stored container block means the assignment was configured in container
    // mode; otherwise it's the hosted runner (the default).
    runtime_env: assignment.runtime?.container ? "container" : "hosted",
    runs_on: parseRunnerLabels(assignment.runtime?.["runs-on"] ?? "").join(
      ", ",
    ),
    container_image: assignment.runtime?.container?.image ?? "",
    container_user: assignment.runtime?.container?.user ?? "",
    runtime_python: assignment.runtime?.python ?? "",
    runtime_node: assignment.runtime?.node ?? "",
    runtime_java: assignment.runtime?.java ?? "",
    runtime_go: assignment.runtime?.go ?? "",
    // apt is hosted-only; a stored container block hides the apt field and the
    // submit path clears it, so blank it on read too — otherwise a legacy
    // container+apt entry would hold apt live-but-hidden and silently drop it.
    runtime_apt: assignment.runtime?.container
      ? ""
      : aptPackagesToText(assignment.runtime?.apt),
    setup_command: setupCommand,
    pass_threshold_enabled: typeof assignment.pass_threshold === "number",
    pass_threshold: assignment.pass_threshold ?? DEFAULT_PASS_THRESHOLD,
    allowed_files: allowedFilesToText(assignment.allowed_files),
    tests,
  }
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
  const tzShort = new Intl.DateTimeFormat(undefined, {
    timeZoneName: "short",
  })
    .formatToParts(new Date())
    .find((part) => part.type === "timeZoneName")?.value

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
        <div className="card bg-base-100 w-full shadow-sm mb-6">
          <div className="card-body">
            <h3 className="text-lg font-bold pb-4">
              {t("assignments.form.basicInfo")}
            </h3>

            <form.Field name="name">
              {(field) => (
                <>
                  <label htmlFor={field.name} className="label font-bold">
                    {t("assignments.form.name")}
                    <span className="text-error">*</span>
                  </label>
                  <input
                    id={field.name}
                    name={field.name}
                    type="text"
                    required
                    aria-required="true"
                    className="input w-full mb-4"
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
                </>
              )}
            </form.Field>

            {!edit && (
              <form.Field name="slug">
                {(field) => (
                  <>
                    <label htmlFor={field.name} className="label font-bold">
                      {t("assignments.form.slug")}
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
                      className="input w-full"
                      placeholder={t("assignments.form.slugPlaceholder")}
                      value={field.state.value}
                      onBlur={(e) => {
                        // Normalize on blur so what the teacher sees is what's
                        // saved (the repo path segment).
                        field.handleChange(slugify(e.target.value))
                        field.handleBlur()
                      }}
                      onChange={(e) => {
                        setSlugTouched(true)
                        field.handleChange(e.target.value)
                      }}
                    />
                    <p className="mt-1.5 mb-4 text-sm text-base-content/70">
                      {t("assignments.form.slugHelp")}
                    </p>
                    {field.state.meta.errors.length > 0 && (
                      <p
                        id={`${field.name}-error`}
                        className="text-error text-sm mb-4"
                        role="alert"
                      >
                        {String(field.state.meta.errors[0])}
                      </p>
                    )}
                  </>
                )}
              </form.Field>
            )}

            <form.Field name="description">
              {(field) => (
                <>
                  <label htmlFor={field.name} className="label font-bold">
                    {t("assignments.form.description")}
                  </label>
                  <textarea
                    id={field.name}
                    name={field.name}
                    className="textarea w-full mb-4"
                    placeholder={t("assignments.form.descriptionPlaceholder")}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                </>
              )}
            </form.Field>

            <div className="grid grid-cols-1 gap-4 mb-4 sm:grid-cols-2 sm:items-start">
              <div>
                <form.Field name="template_repo">
                  {(field) => (
                    <TemplateField
                      field={field}
                      org={org}
                      classroom={classroom}
                    />
                  )}
                </form.Field>
              </div>
              <div>
                <form.Field name="due_date">
                  {(field) => (
                    <>
                      <label
                        htmlFor={field.name}
                        className="label font-bold mb-2"
                      >
                        {t("assignments.form.dueDate", { tz: tzShort })}
                      </label>
                      <input
                        id={field.name}
                        name={field.name}
                        type="datetime-local"
                        className="input w-full"
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                      />
                    </>
                  )}
                </form.Field>
              </div>
            </div>

            <div>
              <form.Field name="mode">
                {(field) => (
                  <fieldset>
                    <legend className="label font-bold mb-2">
                      {t("assignments.form.type")}
                    </legend>
                    <input
                      id={`${field.name}-individual`}
                      type="radio"
                      className="radio"
                      name={field.name}
                      value="individual"
                      checked={field.state.value === "individual"}
                      onBlur={field.handleBlur}
                      onChange={() => field.handleChange("individual")}
                    />
                    <label
                      htmlFor={`${field.name}-individual`}
                      className="label pl-2"
                    >
                      {t("assignments.form.typeIndividual")}
                    </label>
                    <input
                      id={`${field.name}-group`}
                      type="radio"
                      className="radio ml-6"
                      name={field.name}
                      value="group"
                      checked={field.state.value === "group"}
                      onBlur={field.handleBlur}
                      onChange={() => field.handleChange("group")}
                    />
                    <label
                      htmlFor={`${field.name}-group`}
                      className="label pl-2"
                    >
                      {t("assignments.form.typeGroup")}
                    </label>
                  </fieldset>
                )}
              </form.Field>
            </div>

            <form.Subscribe selector={(state) => state.values.mode}>
              {(modeValue) =>
                modeValue === "group" && (
                  <div>
                    <form.Field name="max_group_size">
                      {(field) => (
                        <>
                          <div>
                            <label
                              htmlFor={field.name}
                              className="label font-bold mb-2"
                            >
                              {t("assignments.form.maxGroupSize")}
                            </label>
                          </div>
                          <input
                            id={field.name}
                            name={field.name}
                            type="number"
                            className="input validator"
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
                        </>
                      )}
                    </form.Field>
                  </div>
                )
              }
            </form.Subscribe>

            <form.Field name="feedback_pr">
              {(field) => (
                <div className="mt-4 flex items-start gap-3">
                  <input
                    id={field.name}
                    type="checkbox"
                    className="toggle toggle-primary mt-0.5"
                    name={field.name}
                    checked={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.checked)}
                  />
                  <div>
                    <div className="flex items-center gap-2">
                      <label htmlFor={field.name} className="label font-bold">
                        {t("assignments.form.feedbackPr")}
                      </label>
                      <span
                        className={`badge badge-sm ${
                          field.state.value
                            ? "badge-success badge-soft"
                            : "badge-ghost"
                        }`}
                      >
                        {field.state.value
                          ? t("assignments.form.enabled")
                          : t("assignments.form.disabled")}
                      </span>
                    </div>
                    <p className="text-sm text-base-content/70">
                      {t("assignments.form.feedbackPrHelp")}
                    </p>
                  </div>
                </div>
              )}
            </form.Field>
          </div>
          <FormErrors form={form} />
        </div>

        <div className="card bg-base-100 w-full shadow-sm mb-6">
          <div className="card-body">
            <details className="group">
              <summary className="cursor-pointer text-lg font-bold marker:content-none flex items-center gap-2">
                <span className="transition-transform group-open:rotate-90">
                  ▶
                </span>
                {t("assignments.form.advanced")}
              </summary>

              <p className="label pt-2 pb-4">
                {t("assignments.form.advancedHelp")}
              </p>

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
                  runtimeEnv === "container" ? (
                    <ContainerFields form={form} />
                  ) : null
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
                    <input
                      id={field.name}
                      name={field.name}
                      type="text"
                      className="input w-full"
                      placeholder={t(
                        "assignments.form.setupCommandPlaceholder",
                      )}
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
                      <textarea
                        id={field.name}
                        name={field.name}
                        className="textarea w-full font-mono"
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
                          onChange={(e) =>
                            toggle.handleChange(e.target.checked)
                          }
                        />
                        {t("assignments.form.passThresholdToggle")}
                      </label>
                      <HelpTooltip
                        help={t("assignments.form.passThresholdTip")}
                      />
                    </div>

                    {toggle.state.value && (
                      <form.Field name="pass_threshold">
                        {(field) => {
                          const error = field.state.meta.errors[0] as
                            string | undefined
                          return (
                            <div className="mt-3">
                              <div className="flex items-center gap-2">
                                <input
                                  id={field.name}
                                  name={field.name}
                                  type="number"
                                  inputMode="numeric"
                                  min={PASS_THRESHOLD_MIN}
                                  max={PASS_THRESHOLD_MAX}
                                  step={1}
                                  className="input w-28"
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
          </div>
        </div>

        <AutogradingTestsPane form={form} />
      </fieldset>
      <div className="divider" />
      <div className="card-actions justify-end p-2">
        {onCancel && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onCancel}
            disabled={loading}
          >
            {readOnly ? t("assignments.form.back") : t("common.cancel")}
          </button>
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
              <button
                type="submit"
                className="btn btn-primary"
                disabled={
                  !canSubmit ||
                  isSubmitting ||
                  loading ||
                  (edit && isDefaultValue)
                }
              >
                {isSubmitting || loading ? (
                  <span
                    className="loading loading-spinner"
                    aria-hidden="true"
                  />
                ) : edit ? (
                  t("assignments.form.saveChanges")
                ) : (
                  t("assignments.form.createButton")
                )}
              </button>
            )}
          </form.Subscribe>
        )}
      </div>
    </form>
  )
}

export default CreateAssignmentForm
