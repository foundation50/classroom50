import type { CreateAssignmentFormValues } from "../assignmentFormModel"

// Per-section status (R2): a teacher scans the section headers to see progress
// without reading each section's contents.
//   - "error"      : a field the section owns has a validation error.
//   - "configured" : no error, and the section holds a non-default value.
//   - "default"    : no error and every owned field is still at its default.
export type SectionStatus = "error" | "configured" | "default"

// The sections, in render order. Each owns a disjoint slice of the form fields;
// the status derivation keys off these lists so a field belongs to exactly one
// section's badge. "submission" owns how a submission is defined (trigger +
// milestone tags), split out of Autograding so the "what counts as a
// submission" question has its own home, right after Repository Setup.
export type SectionId =
  | "details"
  | "repository"
  | "submission"
  | "autograding"
  | "features"
  | "schedule"

// The fields each section owns, for both the error scan (which validation keys
// map to this section) and the configured scan (which values to compare against
// their default). Kept here as the single ownership map so a moved field
// updates its badge in one place.
const SECTION_FIELDS: Record<
  SectionId,
  ReadonlyArray<keyof CreateAssignmentFormValues>
> = {
  details: ["name", "slug", "description", "mode", "max_group_size"],
  repository: [
    "repo_source",
    "add_readme",
    "include_all_branches",
    "empty_repo",
    "template_repo",
    "student_permission",
    "feedback_pr",
  ],
  autograding: [
    "runtime_env",
    "runs_on",
    "container_image",
    "container_user",
    "runtime_python",
    "runtime_node",
    "runtime_java",
    "runtime_go",
    "runtime_rust",
    "runtime_apt",
    "setup_command",
    "setup_timeout",
    "allowed_files",
    "release_assets",
    "pass_threshold_enabled",
    "pass_threshold",
    "tests",
  ],
  submission: [
    "submission_mode",
    "submission_tags",
    "grading_choice",
    "grading_max_points",
  ],
  features: [
    "repo_feature_issues",
    "repo_feature_wiki",
    "repo_feature_projects",
    "repo_feature_pull_requests",
  ],
  schedule: ["available_from_date", "due_date"],
}

// A validation error key belongs to a section when it names one of that
// section's fields, or is an indexed sub-key of one (e.g. "tests[0].name"
// belongs to autograding's "tests"). This mirrors validateAssignmentForm's
// keying so the badge and the field-level error stay in agreement.
function errorBelongsToSection(errorKey: string, section: SectionId): boolean {
  return SECTION_FIELDS[section].some(
    (field) => errorKey === field || errorKey.startsWith(`${field}[`),
  )
}

// Whether the section holds any non-default value. Compared against the form's
// baseline defaults (the create-form initial state), so an untouched section
// reads "default" and a filled one reads "configured". Fields the section
// doesn't own are ignored.
function sectionIsConfigured(
  section: SectionId,
  values: CreateAssignmentFormValues,
  defaults: CreateAssignmentFormValues,
): boolean {
  return SECTION_FIELDS[section].some((field) => {
    const value = values[field]
    // tests is an array; any test means configured.
    if (field === "tests") return Array.isArray(value) && value.length > 0
    return value !== defaults[field]
  })
}

export function deriveSectionStatus(
  section: SectionId,
  values: CreateAssignmentFormValues,
  defaults: CreateAssignmentFormValues,
  errors: Record<string, string>,
): SectionStatus {
  const hasError = Object.keys(errors).some((key) =>
    errorBelongsToSection(key, section),
  )
  if (hasError) return "error"
  return sectionIsConfigured(section, values, defaults)
    ? "configured"
    : "default"
}
