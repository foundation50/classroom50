import { useForm } from "@tanstack/react-form"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { slugify } from "@/util/slug"
import {
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Loader2,
  ServerCog,
} from "lucide-react"
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
import {
  containerRunnerWarning,
  isRunnerLabelShapeValid,
  verifyRunnerLabels,
  parseRunnerLabels,
  isKnownHostedRunnerLabel,
  isStandardSelfHostedLabel,
  type OrgRunnersResult,
  type RunnerVerification,
} from "@/util/runners"
import { orgRunnersQuery } from "@/hooks/github/queries"
import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
import { TemplateField } from "./TemplateField"
import {
  useDebouncedValue,
  normalizeOnBlur,
  type StringField,
} from "./formFieldHelpers"
import type { Assignment } from "@/types/classroom"
import { GROUP_SIZE_MAX, GROUP_SIZE_MIN } from "@/types/classroom"
import {
  DEFAULT_PASS_THRESHOLD,
  PASS_THRESHOLD_MAX,
  PASS_THRESHOLD_MIN,
} from "@/types/classroom"

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
  runs_on: string
  container_image: string
  container_user: string
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
      runs_on: defaultValues?.runs_on || "",
      container_image: defaultValues?.container_image || "",
      container_user: defaultValues?.container_user || "",
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

        return Object.keys(errors).length > 0 ? { fields: errors } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      await onSubmit({
        name: value.name.trim(),
        slug: slugify(value.slug),
        description: value.description.trim(),
        mode: value.mode,
        template_repo: value.template_repo.trim(),
        due_date: value.due_date.trim(),
        max_group_size: value.max_group_size,
        feedback_pr: value.feedback_pr,
        runs_on: value.runs_on.trim(),
        container_image: value.container_image.trim(),
        container_user: value.container_user.trim(),
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

// Free-form runner input with advisory, non-blocking verification: annotates
// the value but never rewrites or clears what the teacher typed.
const RunnerField = ({ field, org }: { field: StringField; org?: string }) => {
  const { t } = useTranslation()
  const client = useOptionalGitHubClient()
  const rawValue = field.state.value
  const debouncedValue = useDebouncedValue(rawValue.trim(), 400)

  // Hit the org runners API only for a well-shaped label not already recognized
  // client-side; everything else needs no network call.
  const needsOrgLookup = Boolean(
    client &&
    org &&
    parseRunnerLabels(debouncedValue).some(
      (label) =>
        isRunnerLabelShapeValid(label) &&
        !isKnownHostedRunnerLabel(label) &&
        !isStandardSelfHostedLabel(label),
    ),
  )

  const orgRunnersResultQuery = useQuery({
    ...orgRunnersQuery(client!, org ?? ""),
    enabled: needsOrgLookup,
  })

  const orgRunners: OrgRunnersResult = needsOrgLookup
    ? (orgRunnersResultQuery.data ?? { available: false, reason: "error" })
    : { available: false, reason: "no-access" }

  // Hold off on the "not found" verdict while the lookup is in flight.
  const isVerifying = needsOrgLookup && orgRunnersResultQuery.isLoading

  const pending = rawValue.trim() !== debouncedValue
  const verification = verifyRunnerLabels(debouncedValue, orgRunners)

  return (
    <div>
      <label htmlFor={field.name} className="label block font-bold mb-1.5">
        {t("assignments.form.runner.label")}
      </label>
      <input
        id={field.name}
        name={field.name}
        type="text"
        autoComplete="off"
        spellCheck={false}
        className="input w-full max-w-xs"
        placeholder="ubuntu-latest"
        value={rawValue}
        onBlur={normalizeOnBlur(field, (value) =>
          parseRunnerLabels(value).join(", "),
        )}
        onChange={(e) => field.handleChange(e.target.value)}
      />

      <RunnerVerificationNote
        verification={verification}
        pending={pending || isVerifying}
        hasValue={verification.kind !== "empty"}
      />

      {verification.kind === "self-hosted" && (
        <p className="mt-1.5 text-xs text-base-content/70">
          {t("assignments.form.runner.selfHostedHint_prefix")}{" "}
          <code>self-hosted, linux, x64</code>
          {t("assignments.form.runner.selfHostedHint_suffix")}
        </p>
      )}
    </div>
  )
}

const RunnerVerificationNote = ({
  verification,
  pending,
  hasValue,
}: {
  verification: RunnerVerification
  pending: boolean
  hasValue: boolean
}) => {
  const { t } = useTranslation()
  if (pending && hasValue) {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 text-sm text-base-content/70">
        <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin" />
        {t("assignments.form.runner.checking")}
      </p>
    )
  }

  switch (verification.kind) {
    case "empty":
      return (
        <p className="mt-1.5 text-sm text-base-content/70">
          {t("assignments.form.runner.emptyHint_prefix")}{" "}
          <code>ubuntu-latest</code>
          {t("assignments.form.runner.emptyHint_suffix")}
        </p>
      )

    case "hosted":
      return (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-success">
          <CheckCircle2 aria-hidden="true" className="size-4 shrink-0" />
          {t("assignments.form.runner.hosted")}
        </p>
      )

    case "self-hosted": {
      const matched = verification.labels.filter(
        (l) => l.kind === "self-hosted-match",
      )
      const matchNames = matched.flatMap((l) =>
        l.kind === "self-hosted-match" ? l.runnerNames : [],
      )
      const uniqueNames = Array.from(new Set(matchNames))
      return (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-success">
          <ServerCog aria-hidden="true" className="size-4 shrink-0" />
          {verification.confirmed && uniqueNames.length > 0
            ? t("assignments.form.runner.selfHostedMatch", {
                count: uniqueNames.length,
                names: `${uniqueNames.slice(0, 3).join(", ")}${
                  uniqueNames.length > 3 ? "…" : ""
                }`,
              })
            : t("assignments.form.runner.selfHostedLabels")}
        </p>
      )
    }

    case "problem": {
      const badShape = verification.labels
        .filter((l) => l.kind === "invalid-shape")
        .map((l) => l.label)
      const unverified = verification.labels
        .filter((l) => l.kind === "unverified")
        .map((l) => l.label)
      const parts: string[] = []
      if (badShape.length > 0) {
        parts.push(
          t("assignments.form.runner.invalidLabel", {
            labels: badShape.map((l) => `"${l}"`).join(", "),
          }),
        )
      }
      if (unverified.length > 0) {
        parts.push(
          t("assignments.form.runner.noRunnerMatch", {
            labels: unverified.map((l) => `"${l}"`).join(", "),
          }),
        )
      }
      return (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-error">
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
          {parts.join(" ")}
        </p>
      )
    }

    case "too-many":
      return (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-error">
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
          {t("assignments.form.runner.tooMany", {
            count: verification.count,
          })}
        </p>
      )

    case "unknown":
      return (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-base-content/70">
          <HelpCircle aria-hidden="true" className="size-4 shrink-0" />
          {t("assignments.form.runner.cannotVerify")}
        </p>
      )

    default:
      return null
  }
}

const toDatetimeLocalValue = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, "0")

  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())

  return `${year}-${month}-${day}T${hours}:${minutes}`
}

// Create-mode default: a week out gives students a sensible runway and avoids
// the form defaulting to an already-overdue "now".
const sevenDaysFromNow = () => {
  const date = new Date()
  date.setDate(date.getDate() + 7)
  return date
}

const utcIsoToDatetimeLocalValue = (value?: string) => {
  if (!value) return ""

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return ""
  }

  return toDatetimeLocalValue(date)
}

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
    runs_on: parseRunnerLabels(assignment.runtime?.["runs-on"] ?? "").join(
      ", ",
    ),
    container_image: assignment.runtime?.container?.image ?? "",
    container_user: assignment.runtime?.container?.user ?? "",
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

              <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
                <form.Field name="runs_on">
                  {(field) => <RunnerField field={field} org={org} />}
                </form.Field>

                <form.Field name="container_image">
                  {(field) => (
                    <div>
                      <label
                        htmlFor={field.name}
                        className="label block font-bold mb-1.5"
                      >
                        {t("assignments.form.dockerImage")}
                      </label>
                      <input
                        id={field.name}
                        name={field.name}
                        type="text"
                        className="input w-full max-w-xs"
                        placeholder={t(
                          "assignments.form.dockerImagePlaceholder",
                        )}
                        value={field.state.value}
                        onBlur={normalizeOnBlur(field)}
                        onChange={(e) => field.handleChange(e.target.value)}
                      />
                      <p className="mt-1.5 text-sm text-base-content/70">
                        {t("assignments.form.dockerImageHelp")}
                      </p>
                    </div>
                  )}
                </form.Field>

                <form.Subscribe
                  selector={(state) => state.values.container_image}
                >
                  {(containerImage) =>
                    containerImage.trim() ? (
                      <form.Field name="container_user">
                        {(field) => (
                          <div>
                            <label
                              htmlFor={field.name}
                              className="block font-bold mb-1.5"
                            >
                              {t("assignments.form.containerUser")}
                            </label>
                            <input
                              id={field.name}
                              name={field.name}
                              type="text"
                              className="input w-full max-w-xs"
                              placeholder={t(
                                "assignments.form.containerUserPlaceholder",
                              )}
                              value={field.state.value}
                              onBlur={normalizeOnBlur(field)}
                              onChange={(e) =>
                                field.handleChange(e.target.value)
                              }
                            />
                            <p className="mt-1.5 text-sm text-base-content/70">
                              {t("assignments.form.containerUserHelp_prefix")}{" "}
                              <code>root</code>
                              {t("assignments.form.containerUserHelp_suffix")}
                            </p>
                          </div>
                        )}
                      </form.Field>
                    ) : null
                  }
                </form.Subscribe>
              </div>

              <form.Subscribe
                selector={(state) => [
                  state.values.runs_on,
                  state.values.container_image,
                ]}
              >
                {([runsOn, containerImage]) => {
                  const warning = containerRunnerWarning(runsOn, containerImage)
                  return warning ? (
                    <p
                      role="alert"
                      className="mt-3 flex items-center gap-1.5 text-sm text-error"
                    >
                      <AlertTriangle
                        aria-hidden="true"
                        className="size-4 shrink-0"
                      />
                      {warning}
                    </p>
                  ) : null
                }}
              </form.Subscribe>

              <form.Field name="setup_command">
                {(field) => (
                  <div className="mt-4">
                    <label
                      htmlFor={field.name}
                      className="label block font-bold mb-1.5"
                    >
                      {t("assignments.form.setupCommand")}
                    </label>
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
                    <p className="mt-1.5 text-sm text-base-content/70">
                      {t("assignments.form.setupCommandHelp")}
                    </p>
                  </div>
                )}
              </form.Field>

              <form.Field name="allowed_files">
                {(field) => {
                  const patterns = parseAllowedFiles(field.state.value)
                  const error = field.state.meta.errors[0] as string | undefined
                  return (
                    <div className="mt-4">
                      <label
                        htmlFor={field.name}
                        className="label block font-bold mb-1.5"
                      >
                        {t("assignments.form.allowedFiles")}
                      </label>
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
                      <p className="mt-1.5 text-sm text-base-content/70">
                        {t("assignments.form.allowedFilesHelp", {
                          gitignore: ".gitignore",
                          bang: "!",
                          star: "*",
                          example: "!hello.py",
                          result: "hello.py",
                        })}
                      </p>
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
                    <label className="label cursor-pointer justify-start gap-3 p-0 font-bold">
                      <input
                        type="checkbox"
                        className="toggle toggle-sm"
                        checked={toggle.state.value}
                        onChange={(e) => toggle.handleChange(e.target.checked)}
                      />
                      {t("assignments.form.passThresholdToggle")}
                    </label>
                    <p className="mt-1.5 text-sm text-base-content/70">
                      {t("assignments.form.passThresholdHelp")}
                    </p>

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
