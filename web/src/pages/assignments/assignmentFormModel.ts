import { useForm } from "@tanstack/react-form"
import type { TFunction } from "i18next"
import { slugify } from "@/util/slug"
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
import { utcIsoToDatetimeLocalValue } from "./formFieldHelpers"
import type { Assignment } from "@/types/classroom"
import {
  GROUP_SIZE_MAX,
  GROUP_SIZE_MIN,
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
  runtime_rust: string
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

// Create-only: slug uniqueness is not validated in edit mode (no rename).
export type SlugContext = { takenSlugs?: string[]; edit?: boolean }

// Pure submit-time validation, mirroring gh-teacher's write-time rules so a bad
// value is caught in the form rather than by a failed commit or an unparseable
// file. Returns a field->message map ({} when valid) so it's testable without a
// form instance.
export function validateAssignmentForm(
  value: CreateAssignmentFormValues,
  t: TFunction,
  slugContext?: SlugContext,
): Record<string, string> {
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
      // Case-insensitive collision (slugs become repo path segments); write
      // path re-checks authoritatively (nextAvailableSlug).
      errors.slug = t("validation.assignmentSlugTaken", { slug })
    }
  }
  if (!Number(value.max_group_size)) {
    errors.max_group_size = t("assignments.form.validation.maxGroupSizeInvalid")
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

  // Mirror gh-teacher's write-time validation so a bad test is caught in the
  // form, not by a failed commit or an unparseable file.
  Object.assign(errors, validateTestDrafts(value.tests))

  // Mirror the CLI's cap/shape rules so a bad value can't reach the file.
  const allowedFilesError = validateAllowedFiles(
    parseAllowedFiles(value.allowed_files),
  )
  if (allowedFilesError) {
    errors.allowed_files = allowedFilesError
  }

  // Only validated when the teacher enabled it. Integer percentage in [0, 100]
  // (mirrors the CLI schema bounds).
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
    rust: value.runtime_rust,
  }
  for (const language of RUNTIME_LANGUAGES) {
    const error = validateLanguageVersion(languageFields[language])
    if (error) {
      errors[`runtime_${language}`] = error
    }
  }
  // apt only applies to the hosted runtime; container mode clears it on submit
  // and hides the input, so only validate it there. The container-vs-apt
  // conflict is now structurally impossible (the two live in different,
  // mutually exclusive modes), so no cross-check.
  if (value.runtime_env !== "container") {
    const aptError = validateAptPackages(parseAptPackages(value.runtime_apt))
    if (aptError) {
      errors.runtime_apt = aptError
    }
  }

  // A container runs on Ubuntu hosts only, so a macOS/Windows runner label
  // can't be combined with a Docker image (mirrors the CLI). A custom/self-
  // hosted or Ubuntu label is fine.
  if (value.runtime_env === "container" && value.container_image.trim()) {
    const badLabel = parseRunnerLabels(value.runs_on).find(
      isNonUbuntuHostedLabel,
    )
    if (badLabel) {
      errors.runs_on = t("assignments.form.runtime.runnerContainerError", {
        label: badLabel,
      })
    }
  }

  // Container image/user shape, mirroring the CLI's ValidateContainer, so an
  // injection-shaped value is caught inline before the write path (which
  // enforces the same gate) rejects it.
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

  return errors
}

// Normalize the raw form state into the trimmed wire shape, clearing the fields
// that don't belong to the selected runtime environment so a hidden, stale
// value from the other mode can't reach the wire. apt is hosted-only (a
// container image owns its packages — the CLI forbids container+apt), and
// container image/user apply only in container mode. runs-on and the language
// versions apply to BOTH modes (a container job can target a specific runner;
// setup-* runs inside a container), so they always pass through.
export function toSubmitValues(
  value: CreateAssignmentFormValues,
): CreateAssignmentFormValues {
  const isContainer = value.runtime_env === "container"
  return {
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
    runtime_rust: value.runtime_rust.trim(),
    runtime_apt: isContainer ? "" : value.runtime_apt.trim(),
    setup_command: value.setup_command.trim(),
    allowed_files: value.allowed_files,
    pass_threshold_enabled: value.pass_threshold_enabled,
    pass_threshold: Number(value.pass_threshold),
    tests: value.tests,
  }
}

export const useAssignmentForm = (
  defaultValues: Partial<CreateAssignmentFormValues> | undefined,
  onSubmit: (values: CreateAssignmentFormValues) => void | Promise<void>,
  t: TFunction,
  slugContext?: SlugContext,
) =>
  useForm({
    defaultValues: {
      name: defaultValues?.name || "",
      slug: defaultValues?.slug || "",
      description: defaultValues?.description || "",
      mode: defaultValues?.mode || "individual",
      template_repo: defaultValues?.template_repo || "",
      due_date: utcIsoToDatetimeLocalValue(defaultValues?.due_date),
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
      runtime_rust: defaultValues?.runtime_rust || "",
      runtime_apt: defaultValues?.runtime_apt || "",
      setup_command: defaultValues?.setup_command || "",
      allowed_files: defaultValues?.allowed_files || "",
      pass_threshold_enabled: defaultValues?.pass_threshold_enabled ?? false,
      pass_threshold: defaultValues?.pass_threshold ?? DEFAULT_PASS_THRESHOLD,
      tests: defaultValues?.tests || [],
    } satisfies CreateAssignmentFormValues,
    validators: {
      onSubmit: ({ value }) => {
        const errors = validateAssignmentForm(value, t, slugContext)
        return Object.keys(errors).length > 0 ? { fields: errors } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      await onSubmit(toSubmitValues(value))
    },
  })

// Concrete form-instance type shared with child panes (AutogradingTestsPane,
// AdvancedRuntimeFields, FormErrors) so their `form` prop is typed without
// restating useForm's generics. Derived from the hook so the generics match.
export type AssignmentForm = ReturnType<typeof useAssignmentForm>

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
    slug: assignment.slug,
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
    runtime_rust: assignment.runtime?.rust ?? "",
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
