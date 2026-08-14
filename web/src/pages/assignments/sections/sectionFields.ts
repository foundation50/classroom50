import type { CreateAssignmentFormValues } from "../assignmentFormModel"

// The form's sections, in render order. Each owns a disjoint slice of the form
// fields; the reset control keys off these lists so a field belongs to exactly
// one section. "submission" (the Submission and Grading section) owns the
// submission definition + milestone tags, the grading choice, AND the
// autograder configuration (built-in toggle, runtime, tests) folded in from the
// former standalone Autograding section.
export type SectionId = "details" | "repository" | "submission" | "schedule"

// The fields each section owns. Used to decide whether a section differs from
// its create defaults (so a Reset control appears) and to restore just that
// section's fields on reset. Kept here as the single ownership map so a moved
// field updates its section in one place.
export const SECTION_FIELDS: Record<
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
    "feedback_pr_template",
    "repo_feature_issues",
    "repo_feature_wiki",
    "repo_feature_projects",
    "repo_feature_pull_requests",
  ],
  submission: [
    "submission_mode",
    "submission_tags",
    "grading_choice",
    "grading_max_points",
    "autograding_state",
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
  schedule: ["available_from_date", "due_date"],
}

// Whether the section holds any non-default value, compared against the form's
// baseline (create) defaults. An untouched section reads false (no Reset shown);
// a changed one reads true. Fields the section doesn't own are ignored.
export function sectionIsConfigured(
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

// Whether a validateAssignmentForm error key belongs to a field, matching the
// field itself or an indexed sub-key of it (e.g. "tests[0].name" -> "tests").
// The single source of truth for that keying convention, so a caller mapping
// errors back to fields can't drift from validateAssignmentForm.
export function errorKeyMatchesField(
  errorKey: string,
  field: keyof CreateAssignmentFormValues,
): boolean {
  return errorKey === field || errorKey.startsWith(`${field}[`)
}
