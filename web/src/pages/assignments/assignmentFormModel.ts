import { useForm } from "@tanstack/react-form"
import type { TFunction } from "i18next"
import { slugify } from "@/util/slug"
import {
  SHORT_NAME_PATTERN_DESCRIPTION,
  isValidShortName,
} from "@/util/shortName"
import type { AssignmentTestDraft } from "@/util/assignmentTests"
import {
  DEFAULT_SETUP_TIMEOUT_SECONDS,
  TEST_TIMEOUT_MAX_SECONDS,
  testToDraft,
  validateTestDrafts,
  validateTestTimeout,
  isSetupTest,
} from "@/util/assignmentTests"
import {
  parseAllowedFiles,
  allowedFilesToText,
  validateAllowedFiles,
} from "@/util/allowedFiles"
import {
  parseReleaseAssets,
  releaseAssetsToText,
  validateReleaseAssets,
} from "@/util/releaseAssets"
import {
  parseSubmissionTags,
  submissionTagsToText,
  validateSubmissionTags,
} from "@/util/submissionTags"
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
import {
  deriveAutogradingState,
  type AutogradingState,
} from "@/domain/assignments/autogradingState"
import { deriveFormShape } from "./formShape"
import { resolveSubmissionMode } from "@/domain/assignments/submissionDetection"
import type {
  Assignment,
  RepoPermission,
  RepoFeatures,
  SubmissionMode,
  GradingMode,
} from "@/types/classroom"
import {
  GROUP_SIZE_MAX,
  GROUP_SIZE_MIN,
  DEFAULT_PASS_THRESHOLD,
  PASS_THRESHOLD_MAX,
  PASS_THRESHOLD_MIN,
  REPO_PERMISSIONS,
  SUBMISSION_MODES,
  GRADING_MODES,
  GRADING_MAX_POINTS_MIN,
} from "@/types/classroom"

// Default manual max-points shown when a teacher first picks manual grading.
const DEFAULT_GRADING_MAX_POINTS = 100

// Which runtime environment the Advanced Settings form is configuring. A UI-
// only discriminator (not a wire field): "hosted" = a GitHub Actions runner
// (runs-on + apt packages), "container" = a Docker image (image + user). The
// two are mutually exclusive on the wire, so the form picks one and clears the
// other's fields, making the runner's container-vs-(runs-on/apt) conflicts
// unrepresentable rather than merely validated-against.
export type RuntimeEnv = "hosted" | "container"

// UI-only repository-source discriminator. "template" starts each repo from a
// template; "none" creates a fresh repo (with or without a README). Folded into
// the wire fields (template / empty_repo) by toSubmitValues.
export type RepoSource = "template" | "none"

export type CreateAssignmentFormValues = {
  name: string
  // URL/repo slug for the assignment (edited on create only).
  slug: string
  description: string
  mode: "group" | "individual"
  template_repo: string
  due_date: string
  // Release date (datetime-local wall-clock, "" when unset).
  available_from_date: string
  max_group_size: number
  feedback_pr: boolean
  // Use the template repo's native pull_request_template.md as the Feedback PR
  // body instead of the built-in body. Only meaningful with feedback_pr on and
  // a template source; cleared on submit otherwise. Maps to the wire
  // feedback_pr_template. Auto-checked when the form detects a template PR file.
  feedback_pr_template: boolean
  // Truly bare student repos: no starter content, no control files, autograding
  // and the Feedback PR off. Immutable after creation (the edit form renders it
  // locked). While checked, the template/autograding/advanced grading sections
  // are hidden and their values cleared on submit, mirroring runtime_env's
  // conditional-clear idiom.
  empty_repo: boolean
  // UI-only repository-source discriminator (never sent verbatim; folds into
  // empty_repo + template_repo on submit). "template" = start from a template
  // repo; "none" = no template. Default is "none", mirroring GitHub's own
  // "create a repository" flow. Derived on read from whether a template is set.
  repo_source: RepoSource
  // UI-only, only meaningful when repo_source === "none": whether to initialize
  // the repo with a README (an initial commit). README on maps to empty_repo:
  // false (auto_init — a baseline commit, so branches/PRs/Feedback PR work);
  // README off maps to empty_repo: true (a bare repo, no commit). Hidden when a
  // template is chosen (the template provides the initial commit).
  add_readme: boolean
  // UI-only, only meaningful for a template source: copy ALL of the template's
  // branches (not just the default) when each student repo is generated. Maps
  // to the wire include_all_branches; cleared on submit when the source isn't a
  // template. Default off.
  include_all_branches: boolean
  // Copy the template's About (description) / Topics onto each student repo at
  // accept time. Only meaningful for a template source (nothing to copy from
  // otherwise); cleared on submit when the source isn't a template. Map to the
  // wire copy_about / copy_topics. Default off. See issue #569.
  copy_about: boolean
  copy_topics: boolean
  // UI-only autograding tri-state (never sent verbatim; mapped to wire fields
  // on submit): "empty" (bare repo — driven by empty_repo), "none" (no built-in
  // autograder — teacher-supplied CI on a template maps to no_autograder: true,
  // a template-less repo just carries no shim), "built-in" (the default-shim
  // path with advanced/tests). It is the built-in-autograder toggle inside the
  // Autograding section, offered only when grading_choice is "auto" and default
  // "none". Read from the stored entry via deriveAutogradingState; on submit the
  // wire no_autograder/init_shim are derived from deriveFormShape (which also
  // requires grading_choice === "auto"). Mirrors the runtime_env
  // UI-only-discriminator idiom.
  autograding_state: AutogradingState
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
  setup_timeout: number
  // Raw textarea text; parsed to string[] on save, joined back on read.
  allowed_files: string
  // Raw textarea text (exact workspace-relative paths, one per line).
  release_assets: string
  // Opt-in passing threshold (off by default). When enabled, pass_threshold is
  // an integer percentage 0–100; when disabled, no passing concept is written.
  pass_threshold_enabled: boolean
  pass_threshold: number
  // The accept-time collaborator role the enrolled student gets on their own
  // repo. "" = the mode default (push individual / admin group); a real value
  // pins it. buildAssignmentEntry omits it when it equals the default and
  // clamps group up to admin.
  student_permission: "" | RepoPermission
  // When the autograder fires: "every-push" (the default; omitted on the
  // wire) or "tag" (only submit/* tag pushes grade — the submit flows push
  // the tag; plain `git push` costs no Actions minutes). Baked into each
  // repo's shim at accept time; editing it later requires retrofitting
  // existing repos (submissions-page bulk action or the CLI).
  submission_mode: SubmissionMode
  // Raw textarea text (one milestone tag pattern per line); parsed to
  // string[] on save, joined back on read. Empty = no milestone tags.
  submission_tags: string
  // The teacher's grading intent: "off" (not graded), "auto" (autograded — the
  // default), or "manual" (teacher enters scores on the submissions page).
  // Maps to the wire grading.mode; ABSENT on the wire reads as "auto". Shown
  // regardless of the autograding tri-state (a bare/teacher-CI repo can still
  // be graded manually).
  grading_choice: GradingMode
  // Total points for a manual assignment; only meaningful when
  // grading_choice === "manual" (cleared on submit otherwise). Maps to the wire
  // grading.max_points (>= 1).
  grading_max_points: number
  // Per-feature repo override, tri-state (one control shape regardless of
  // template): "inherit" writes no key (absent = inherit the template when
  // templated, else GitHub's own create default), "on"/"off" force the feature.
  // Round-trips to Assignment["repo_features"] via repoFeaturesToFormValues /
  // formValuesToRepoFeatures.
  repo_feature_issues: RepoFeatureChoice
  repo_feature_wiki: RepoFeatureChoice
  repo_feature_projects: RepoFeatureChoice
  repo_feature_pull_requests: RepoFeatureChoice
  tests: AssignmentTestDraft[]
}

// A single repo-feature control's value. "inherit" is the default and omits the
// wire key; "on"/"off" force true/false.
export type RepoFeatureChoice = "inherit" | "on" | "off"

// Read mapping: a stored boolean/absent -> the form choice. Absent (or an
// absent object) is "inherit"; true is "on"; false is "off". Shared by create
// and edit so a stored "off" never silently reverts to "inherit" on edit.
export function repoFeatureChoice(
  value: boolean | undefined,
): RepoFeatureChoice {
  if (value === undefined) return "inherit"
  return value ? "on" : "off"
}

// Write mapping: the three form choices -> the Assignment repo_features object,
// omitting any "inherit" key. Returns undefined when every choice inherits so the
// caller can omit the block entirely (matching buildAssignmentEntry's
// omit-when-empty rule).
export function formValuesToRepoFeatures(
  value: Pick<
    CreateAssignmentFormValues,
    | "repo_feature_issues"
    | "repo_feature_wiki"
    | "repo_feature_projects"
    | "repo_feature_pull_requests"
  >,
): RepoFeatures | undefined {
  const result: RepoFeatures = {}
  const apply = (
    choice: RepoFeatureChoice,
    key: "issues" | "wiki" | "projects" | "pull_requests",
  ) => {
    if (choice === "on") result[key] = true
    else if (choice === "off") result[key] = false
  }
  apply(value.repo_feature_issues, "issues")
  apply(value.repo_feature_wiki, "wiki")
  apply(value.repo_feature_projects, "projects")
  apply(value.repo_feature_pull_requests, "pull_requests")
  return Object.keys(result).length > 0 ? result : undefined
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
    } else if (!isValidShortName(slug)) {
      // Same cross-tool short-name contract as classroom slugs (both become
      // repo path segments); the write path historically skipped it.
      errors.slug = t("assignments.form.validation.slugInvalid", {
        description: SHORT_NAME_PATTERN_DESCRIPTION,
      })
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

  if (!value.empty_repo && value.setup_command.trim()) {
    const setupTimeoutError = validateTestTimeout(value.setup_timeout)
    if (setupTimeoutError) {
      errors.setup_timeout = t(
        "assignments.form.validation.setupTimeoutRange",
        { max: TEST_TIMEOUT_MAX_SECONDS },
      )
    }
  }

  // Mirror the CLI's cap/shape rules so a bad value can't reach the file.
  const allowedFilesError = validateAllowedFiles(
    parseAllowedFiles(value.allowed_files),
  )
  if (allowedFilesError) {
    errors.allowed_files = allowedFilesError
  }

  if (!value.empty_repo) {
    const releaseAssetsError = validateReleaseAssets(
      parseReleaseAssets(value.release_assets),
    )
    if (releaseAssetsError) {
      switch (releaseAssetsError.kind) {
        case "too-many":
          errors.release_assets = t(
            "assignments.form.validation.releaseAssetsTooMany",
            { count: releaseAssetsError.count, max: releaseAssetsError.max },
          )
          break
        case "too-large":
          errors.release_assets = t(
            "assignments.form.validation.releaseAssetsTooLarge",
            { bytes: releaseAssetsError.bytes, max: releaseAssetsError.max },
          )
          break
        case "invalid-path":
          errors.release_assets = t(
            "assignments.form.validation.releaseAssetsInvalidPath",
            { path: releaseAssetsError.path },
          )
          break
        case "invalid-basename":
          errors.release_assets = t(
            "assignments.form.validation.releaseAssetsInvalidBasename",
            { basename: releaseAssetsError.basename },
          )
          break
        case "duplicate-path":
          errors.release_assets = t(
            "assignments.form.validation.releaseAssetsDuplicatePath",
            { path: releaseAssetsError.path },
          )
          break
        case "duplicate-basename":
          errors.release_assets = t(
            "assignments.form.validation.releaseAssetsDuplicateBasename",
            { basename: releaseAssetsError.basename },
          )
          break
        default:
          // Exhaustiveness guard: a new ReleaseAssetsValidationError kind must
          // add a case here or this fails to compile (the drop that let
          // duplicate-path slip through silently).
          releaseAssetsError satisfies never
      }
    }
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

  // Guard the permission picker against a hand-tampered value; empty is valid
  // (means the mode default).
  if (
    value.student_permission !== "" &&
    !REPO_PERMISSIONS.includes(value.student_permission)
  ) {
    errors.student_permission = t(
      "assignments.form.validation.studentPermissionInvalid",
    )
  }

  // Guard the submission-mode picker against a hand-tampered value.
  if (!SUBMISSION_MODES.includes(value.submission_mode)) {
    errors.submission_mode = t(
      "assignments.form.validation.submissionModeInvalid",
    )
  }

  // Mirror the CLI's ValidateSubmissionTags so a bad pattern can't reach the
  // file (the util returns its own user-readable message). Only validated in
  // "tag" mode: the tags field is hidden and cleared on submit for every-push,
  // so a stale value there must not raise an error the teacher can't see to fix.
  if (value.submission_mode === "tag") {
    const submissionTagsError = validateSubmissionTags(
      parseSubmissionTags(value.submission_tags),
    )
    if (submissionTagsError) {
      errors.submission_tags = submissionTagsError
    }
  }

  // Guard the grading picker against a hand-tampered value.
  if (!GRADING_MODES.includes(value.grading_choice)) {
    errors.grading_choice = t("assignments.form.validation.gradingModeInvalid")
  } else if (value.grading_choice === "manual") {
    // Manual grading needs a whole-number max >= 1 (a 0 max is the ungraded
    // sentinel the submissions UI divides by). Mirrors the CLI ValidateGrading.
    const max = Number(value.grading_max_points)
    if (!Number.isInteger(max) || max < GRADING_MAX_POINTS_MIN) {
      errors.grading_max_points = t(
        "assignments.form.validation.gradingMaxPointsInvalid",
        { min: GRADING_MAX_POINTS_MIN },
      )
    }
  }

  return errors
}

// Whether switching the grading choice should seed the built-in autograder.
// "Autograded" almost always means the built-in autograder, so entering that
// mode preselects it — but only as a first-entry default: a teacher who has
// deliberately touched the autograder pick (choosing teacher-supplied CI, or
// re-confirming built-in) keeps their choice across a grading round-trip. Pure
// so the rule is unit-testable apart from the form instance.
export function shouldSeedBuiltInAutograder({
  next,
  previous,
  autogradingState,
  autogradingTouched,
}: {
  // The grading choice being switched to, and the one being left.
  next: GradingMode
  previous: GradingMode
  autogradingState: AutogradingState
  // Whether the teacher has interacted with the autograder pick (its field is
  // dirty). A stored assignment's value counts as deliberate too, so edit-mode
  // round-trips never re-seed over it.
  autogradingTouched: boolean
}): boolean {
  if (next !== "auto" || previous === "auto") return false
  if (autogradingTouched) return false
  return autogradingState !== "built-in"
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
  // One derived shape drives every clear below, so the render gates (which read
  // the same deriveFormShape) and the submit clears can't drift. empty_repo
  // forces autogradingState "empty" inside deriveFormShape; a bare repo and
  // teacher-supplied CI ("none") both commit no shim, so both clear the built-
  // in-only grading fields — but only empty_repo also clears template and
  // feedback_pr (a templated repo has a baseline commit).
  const shape = deriveFormShape(value)
  const isContainer = shape.showContainerFields
  const isEmptyRepo = shape.emptyRepo
  // Only a template source keeps template_repo; the no-template sources
  // ("readme"/"empty") clear it so a stale ref can't reach the wire.
  const isTemplate = shape.repositorySource === "template"
  const noBuiltIn = !shape.showBuiltInConfig
  return {
    name: value.name.trim(),
    slug: slugify(value.slug),
    description: value.description.trim(),
    mode: value.mode,
    template_repo: isTemplate ? value.template_repo.trim() : "",
    due_date: value.due_date.trim(),
    available_from_date: value.available_from_date.trim(),
    max_group_size: value.max_group_size,
    feedback_pr: isEmptyRepo ? false : value.feedback_pr,
    // Only meaningful with a template source and the Feedback PR on; clear it
    // otherwise so a stale toggle can't reach the wire (buildAssignmentEntry
    // also rejects the combo).
    feedback_pr_template:
      isTemplate && !isEmptyRepo && value.feedback_pr
        ? value.feedback_pr_template
        : false,
    empty_repo: isEmptyRepo,
    repo_source: value.repo_source,
    add_readme: value.add_readme,
    // Only meaningful for a template source; clear it otherwise so a stale
    // toggle can't reach the wire (buildAssignmentEntry also rejects the combo).
    include_all_branches: isTemplate ? value.include_all_branches : false,
    // Copy About/Topics only make sense with a template to copy from; clear
    // them for a non-template source so a stale toggle can't reach the wire
    // (buildAssignmentEntry also rejects the combo). Issue #569.
    copy_about: isTemplate ? value.copy_about : false,
    copy_topics: isTemplate ? value.copy_topics : false,
    autograding_state: shape.autogradingState,
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
    setup_command: noBuiltIn ? "" : value.setup_command.trim(),
    setup_timeout: noBuiltIn ? 0 : value.setup_timeout,
    allowed_files: noBuiltIn ? "" : value.allowed_files,
    release_assets: noBuiltIn ? "" : value.release_assets,
    pass_threshold_enabled: noBuiltIn ? false : value.pass_threshold_enabled,
    pass_threshold: Number(value.pass_threshold),
    student_permission: value.student_permission,
    // The submission MODE is how the app identifies submissions and is valid
    // for every repo shape (with a shim it also drives the trigger; without one
    // it's the detection definition), so it is NOT cleared by noBuiltIn.
    submission_mode: value.submission_mode,
    // Tags only refine the "tagged commit" mode, and the form hides the field
    // in every-push mode — so clear any stale value there to keep the wire
    // consistent with what the teacher sees (no hidden tags persisting).
    submission_tags:
      value.submission_mode === "tag" ? value.submission_tags : "",
    // Grading intent is orthogonal to the autograding tri-state (a bare or
    // teacher-CI repo can still be graded manually), so it is NOT cleared by
    // noBuiltIn. Only the manual max-points is normalized: kept when manual,
    // reset otherwise so a stale value can't reach the wire.
    grading_choice: value.grading_choice,
    grading_max_points:
      value.grading_choice === "manual"
        ? Number(value.grading_max_points)
        : DEFAULT_GRADING_MAX_POINTS,
    // Uniform tri-state controls; "inherit" is the default and resolves to the
    // template's feature (templated) or GitHub's own create default (template-
    // less) at accept time, so no template-dependent default-flip is needed here.
    repo_feature_issues: value.repo_feature_issues,
    repo_feature_wiki: value.repo_feature_wiki,
    repo_feature_projects: value.repo_feature_projects,
    repo_feature_pull_requests: value.repo_feature_pull_requests,
    tests: isEmptyRepo ? [] : value.tests,
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
      available_from_date: utcIsoToDatetimeLocalValue(
        defaultValues?.available_from_date,
      ),
      max_group_size: defaultValues?.max_group_size || 2,
      feedback_pr: defaultValues?.feedback_pr ?? true,
      // Default off; on the create form the template probe auto-checks it when
      // a pull_request_template.md is detected. On edit it reflects the saved
      // value (assignmentToFormValues), and the probe respects a saved choice.
      feedback_pr_template: defaultValues?.feedback_pr_template ?? false,
      empty_repo: defaultValues?.empty_repo ?? false,
      // Default to an uninitialized (empty) repository with no template and no
      // README, mirroring GitHub's "create a repository" defaults. Seeded from
      // the stored wire fields on edit via assignmentToFormValues.
      repo_source: defaultValues?.repo_source ?? "none",
      add_readme: defaultValues?.add_readme ?? false,
      include_all_branches: defaultValues?.include_all_branches ?? false,
      // Default ON for a new assignment: copying the template's About/Topics is
      // the expected behavior (GitHub's generate drops both). Edit round-trips
      // the stored value via assignmentToFormValues (absent reads as false, the
      // wire's omitempty shape), so this create-only default never silently
      // re-enables a flag a teacher turned off.
      copy_about: defaultValues?.copy_about ?? true,
      copy_topics: defaultValues?.copy_topics ?? true,
      autograding_state: defaultValues?.autograding_state ?? "none",
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
      setup_timeout:
        defaultValues?.setup_timeout ?? DEFAULT_SETUP_TIMEOUT_SECONDS,
      allowed_files: defaultValues?.allowed_files || "",
      release_assets: defaultValues?.release_assets || "",
      pass_threshold_enabled: defaultValues?.pass_threshold_enabled ?? false,
      pass_threshold: defaultValues?.pass_threshold ?? DEFAULT_PASS_THRESHOLD,
      student_permission: defaultValues?.student_permission ?? "",
      submission_mode: resolveSubmissionMode(defaultValues?.submission_mode),
      submission_tags: defaultValues?.submission_tags || "",
      // Create default is "off" (not graded); the option order is off ->
      // manual -> auto. On edit, assignmentToFormValues supplies the stored
      // choice (absent grading reads as "auto" for pre-existing assignments).
      grading_choice: defaultValues?.grading_choice ?? "off",
      grading_max_points:
        defaultValues?.grading_max_points ?? DEFAULT_GRADING_MAX_POINTS,
      repo_feature_issues: defaultValues?.repo_feature_issues ?? "inherit",
      repo_feature_wiki: defaultValues?.repo_feature_wiki ?? "inherit",
      repo_feature_projects: defaultValues?.repo_feature_projects ?? "inherit",
      repo_feature_pull_requests:
        defaultValues?.repo_feature_pull_requests ?? "inherit",
      tests: defaultValues?.tests || [],
    } satisfies CreateAssignmentFormValues,
    validators: {
      onSubmit: ({ value }) => {
        const errors = validateAssignmentForm(value, t, slugContext)
        return Object.keys(errors).length > 0 ? { fields: errors } : undefined
      },
    },
    onSubmit: async ({ value, formApi }) => {
      await onSubmit(toSubmitValues(value))
      // Re-baseline to the just-saved values so `isDefaultValue` reads true
      // again — the Save button re-disables until the next edit. Awaited, so a
      // failed write (which rejects) leaves the form dirty and re-submittable.
      // Create navigates away on success, so this is edit-only.
      if (slugContext?.edit) {
        formApi.reset(value)
      }
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
  const setupTimeout = setupIsLeading
    ? (head?.timeout ?? 0)
    : DEFAULT_SETUP_TIMEOUT_SECONDS
  const tests = setupIsLeading ? allTests.slice(1) : allTests

  return {
    name: assignment.name,
    slug: assignment.slug,
    description: assignment.description ?? "",
    mode: assignment.mode === "group" ? "group" : "individual",
    // A custom source branch isn't supported (#673); the stored branch is always
    // the template's own default, so surface just `owner/repo`.
    template_repo: assignment.template
      ? `${assignment.template.owner}/${assignment.template.repo}`
      : "",
    due_date: utcIsoToDatetimeLocalValue(assignment.due),
    available_from_date: utcIsoToDatetimeLocalValue(assignment.available_from),
    max_group_size: assignment.max_group_size ?? 2,
    feedback_pr: assignment.feedback_pr ?? true,
    feedback_pr_template: assignment.feedback_pr_template ?? false,
    empty_repo: assignment.empty_repo ?? false,
    // Fold the stored wire fields back into the UI source discriminator: a
    // template means "template"; otherwise "none". add_readme is true only for
    // a template-less repo that is neither bare (empty_repo) nor shim-only
    // (init_shim) — those two no-README states must round-trip to add_readme
    // false so deriveFormShape re-derives empty_repo/init_shim, not a README
    // repo (which would silently try to flip the immutable flag on re-save).
    repo_source: assignment.template ? "template" : "none",
    add_readme:
      !(assignment.empty_repo ?? false) && !(assignment.init_shim ?? false),
    include_all_branches: assignment.include_all_branches ?? false,
    copy_about: assignment.copy_about ?? false,
    copy_topics: assignment.copy_topics ?? false,
    // Derive the tri-state from the stored wire fields (empty_repo /
    // no_autograder / default), so an edit opens on the right autograding
    // option and a round-trip preserves it. Uses the #554 domain helper.
    autograding_state: deriveAutogradingState(assignment),
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
    setup_timeout: setupTimeout,
    pass_threshold_enabled: typeof assignment.pass_threshold === "number",
    pass_threshold: assignment.pass_threshold ?? DEFAULT_PASS_THRESHOLD,
    // Absent means the mode default; the form shows "Default" and the submit
    // path re-omits it. A stored value pins the picker to that level.
    student_permission: assignment.student_permission ?? "",
    // Absent means every-push (the wire default, collapsed by writers).
    submission_mode: resolveSubmissionMode(assignment.submission_mode),
    // Milestone tag patterns, joined one-per-line for the textarea.
    submission_tags: submissionTagsToText(assignment.submission_tags),
    // Grading intent; absent reads as "auto" (today's behavior). A stored
    // manual max seeds the input, else the default (only used once manual).
    grading_choice: assignment.grading?.mode ?? "auto",
    grading_max_points:
      assignment.grading?.max_points ?? DEFAULT_GRADING_MAX_POINTS,
    // Read mapping: absent object/key -> "inherit", true -> "on", false ->
    // "off", per key, so a stored "off" round-trips instead of reverting.
    repo_feature_issues: repoFeatureChoice(assignment.repo_features?.issues),
    repo_feature_wiki: repoFeatureChoice(assignment.repo_features?.wiki),
    repo_feature_projects: repoFeatureChoice(
      assignment.repo_features?.projects,
    ),
    repo_feature_pull_requests: repoFeatureChoice(
      assignment.repo_features?.pull_requests,
    ),
    allowed_files: allowedFilesToText(assignment.allowed_files),
    release_assets: releaseAssetsToText(assignment.release_assets),
    tests,
  }
}
