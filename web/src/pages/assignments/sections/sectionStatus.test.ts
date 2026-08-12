import { describe, expect, it } from "vitest"
import { deriveSectionStatus } from "./sectionStatus"
import type { CreateAssignmentFormValues } from "../assignmentFormModel"

// The create-form baseline defaults; deriveSectionStatus compares against these
// to tell "configured" from "default". These MUST match useAssignmentForm's
// create defaults (assignmentFormModel.ts): a fresh create form is an
// uninitialized repo with no README, no built-in autograding, and grading off.
const defaults: CreateAssignmentFormValues = {
  name: "",
  slug: "",
  description: "",
  mode: "individual",
  template_repo: "",
  due_date: "",
  available_from_date: "",
  max_group_size: 2,
  feedback_pr: true,
  empty_repo: false,
  repo_source: "none",
  add_readme: false,
  include_all_branches: false,
  copy_about: false,
  copy_topics: false,
  autograding_state: "none",
  runtime_env: "hosted",
  runs_on: "",
  container_image: "",
  container_user: "",
  runtime_python: "",
  runtime_node: "",
  runtime_java: "",
  runtime_go: "",
  runtime_rust: "",
  runtime_apt: "",
  setup_command: "",
  setup_timeout: 120,
  allowed_files: "",
  release_assets: "",
  pass_threshold_enabled: false,
  pass_threshold: 80,
  student_permission: "",
  submission_mode: "every-push",
  submission_tags: "",
  grading_choice: "off",
  grading_max_points: 100,
  repo_feature_issues: "inherit",
  repo_feature_wiki: "inherit",
  repo_feature_projects: "inherit",
  repo_feature_pull_requests: "inherit",
  tests: [],
}

describe("deriveSectionStatus", () => {
  it("reports 'default' for an untouched section", () => {
    expect(deriveSectionStatus("details", defaults, defaults, {})).toBe(
      "default",
    )
    expect(deriveSectionStatus("schedule", defaults, defaults, {})).toBe(
      "default",
    )
  })

  it("reports 'configured' once the section holds a non-default value", () => {
    const values = { ...defaults, name: "Homework 1" }
    expect(deriveSectionStatus("details", values, defaults, {})).toBe(
      "configured",
    )
    // A field another section owns doesn't flip Details.
    const withDue = { ...defaults, due_date: "2026-09-01T23:59" }
    expect(deriveSectionStatus("details", withDue, defaults, {})).toBe(
      "default",
    )
    expect(deriveSectionStatus("schedule", withDue, defaults, {})).toBe(
      "configured",
    )
  })

  it("attributes the folded repo-feature choices to the repository section", () => {
    const wikiOff = { ...defaults, repo_feature_wiki: "off" as const }
    expect(deriveSectionStatus("repository", wikiOff, defaults, {})).toBe(
      "configured",
    )
    // All features left at "inherit" (and no other repo field changed) reads
    // default — the four repo_feature_* fields fold into this one badge.
    expect(deriveSectionStatus("repository", defaults, defaults, {})).toBe(
      "default",
    )
  })

  it("reports 'error' when a validation error names one of the section's fields", () => {
    expect(
      deriveSectionStatus("details", defaults, defaults, {
        name: "assignments.form.validation.nameRequired",
      }),
    ).toBe("error")
    // The error belongs to Details, not Repository Setup.
    expect(
      deriveSectionStatus("repository", defaults, defaults, {
        name: "assignments.form.validation.nameRequired",
      }),
    ).toBe("default")
  })

  it("routes an indexed test error to the autograding section", () => {
    // validateAssignmentForm keys per-test errors as "tests[0].name" etc.; the
    // status must attribute those to the section that owns "tests".
    expect(
      deriveSectionStatus("autograding", defaults, defaults, {
        "tests[0].name": "bad",
      }),
    ).toBe("error")
  })

  it("error wins over configured", () => {
    const values = { ...defaults, name: "Homework 1" }
    expect(
      deriveSectionStatus("details", values, defaults, {
        name: "assignments.form.validation.nameRequired",
      }),
    ).toBe("error")
  })

  it("treats any declarative test as configured autograding", () => {
    const values = {
      ...defaults,
      tests: [{ name: "t", run: "pytest", points: 1 } as never],
    }
    expect(deriveSectionStatus("autograding", values, defaults, {})).toBe(
      "configured",
    )
  })

  it("attributes the submission trigger + tags to the submission section", () => {
    const tagMode = { ...defaults, submission_mode: "tag" as const }
    expect(deriveSectionStatus("submission", tagMode, defaults, {})).toBe(
      "configured",
    )
    // Those fields no longer flip Autograding — they moved to their own section.
    expect(deriveSectionStatus("autograding", tagMode, defaults, {})).toBe(
      "default",
    )
    const withTags = { ...defaults, submission_tags: "phase1" }
    expect(deriveSectionStatus("submission", withTags, defaults, {})).toBe(
      "configured",
    )
  })

  it("attributes the grading choice + max points to the submission section", () => {
    const manual = { ...defaults, grading_choice: "manual" as const }
    expect(deriveSectionStatus("submission", manual, defaults, {})).toBe(
      "configured",
    )
    const maxChanged = { ...defaults, grading_max_points: 42 }
    expect(deriveSectionStatus("submission", maxChanged, defaults, {})).toBe(
      "configured",
    )
    // A grading validation error routes to the submission section.
    expect(
      deriveSectionStatus("submission", defaults, defaults, {
        grading_max_points: "bad",
      }),
    ).toBe("error")
  })

  it("routes a submission_tags validation error to the submission section", () => {
    const errors = { submission_tags: "bad" }
    expect(deriveSectionStatus("submission", defaults, defaults, errors)).toBe(
      "error",
    )
    expect(deriveSectionStatus("autograding", defaults, defaults, errors)).toBe(
      "default",
    )
  })
})
