import { describe, expect, it } from "vitest"
import { deriveSectionStatus } from "./sectionStatus"
import type { CreateAssignmentFormValues } from "../assignmentFormModel"

// The create-form baseline defaults; deriveSectionStatus compares against these
// to tell "configured" from "default". Mirrors useAssignmentForm's defaults.
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
  add_readme: true,
  include_all_branches: false,
  autograding_state: "built-in",
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
})
