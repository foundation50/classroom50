import { describe, expect, it } from "vitest"
import { errorKeyMatchesField, sectionIsConfigured } from "./sectionFields"
import type { CreateAssignmentFormValues } from "../assignmentFormModel"

// The create-form baseline defaults; sectionIsConfigured compares against these
// to decide whether a section differs from its defaults (so a Reset control
// appears). These MUST match useAssignmentForm's create defaults
// (assignmentFormModel.ts): a fresh create form is an uninitialized repo with
// no README, no built-in autograding, and grading off.
const defaults: CreateAssignmentFormValues = {
  name: "",
  slug: "",
  description: "",
  mode: "individual",
  template_repo: "",
  due_date: "",
  available_from_date: "",
  max_group_size: 2,
  team_formation: "teacher",
  feedback_pr: true,
  feedback_pr_template: false,
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
  repo_visibility: "private",
  submission_mode: "every-push",
  submission_tags: "",
  grading_choice: "off",
  grading_max_points: 100,
  repo_feature_issues: "inherit",
  repo_feature_wiki: "inherit",
  repo_feature_projects: "inherit",
  repo_feature_pull_requests: "inherit",
  tests: [],
  test_failure_details: "",
  test_show_output: false,
}

describe("sectionIsConfigured", () => {
  it("is false for an untouched section", () => {
    expect(sectionIsConfigured("details", defaults, defaults)).toBe(false)
    expect(sectionIsConfigured("schedule", defaults, defaults)).toBe(false)
  })

  it("is true once the section holds a non-default value", () => {
    const values = { ...defaults, name: "Homework 1" }
    expect(sectionIsConfigured("details", values, defaults)).toBe(true)
    // A field another section owns doesn't flip Details.
    const withDue = { ...defaults, due_date: "2026-09-01T23:59" }
    expect(sectionIsConfigured("details", withDue, defaults)).toBe(false)
    expect(sectionIsConfigured("schedule", withDue, defaults)).toBe(true)
  })

  it("attributes the folded repo-feature choices to the repository section", () => {
    const wikiOff = { ...defaults, repo_feature_wiki: "off" as const }
    expect(sectionIsConfigured("repository", wikiOff, defaults)).toBe(true)
    // All features left at "inherit" (and no other repo field changed) reads
    // unconfigured — the four repo_feature_* fields fold into this one section.
    expect(sectionIsConfigured("repository", defaults, defaults)).toBe(false)
  })

  it("treats any declarative test as configured submission", () => {
    // The autograder config folds into the submission section, so a declarative
    // test flips that section's Reset.
    const values = {
      ...defaults,
      tests: [{ name: "t", run: "pytest", points: 1 } as never],
    }
    expect(sectionIsConfigured("submission", values, defaults)).toBe(true)
  })

  it("attributes the submission trigger + tags to the submission section", () => {
    const tagMode = { ...defaults, submission_mode: "tag" as const }
    expect(sectionIsConfigured("submission", tagMode, defaults)).toBe(true)
    const withTags = { ...defaults, submission_tags: "phase1" }
    expect(sectionIsConfigured("submission", withTags, defaults)).toBe(true)
  })

  it("attributes the folded autograder config to the submission section", () => {
    const builtIn = { ...defaults, autograding_state: "built-in" as const }
    expect(sectionIsConfigured("submission", builtIn, defaults)).toBe(true)
    // A repo field doesn't flip submission.
    const wikiOff = { ...defaults, repo_feature_wiki: "off" as const }
    expect(sectionIsConfigured("submission", wikiOff, defaults)).toBe(false)
  })

  it("attributes the grading choice + max points to the submission section", () => {
    const manual = { ...defaults, grading_choice: "manual" as const }
    expect(sectionIsConfigured("submission", manual, defaults)).toBe(true)
    const maxChanged = { ...defaults, grading_max_points: 42 }
    expect(sectionIsConfigured("submission", maxChanged, defaults)).toBe(true)
  })

  it("attributes the report defaults to the submission section", () => {
    // The test_defaults controls live in the autograder pane, so changing only
    // them must surface the submission section's Reset (and reset with it).
    const details = { ...defaults, test_failure_details: "none" as const }
    expect(sectionIsConfigured("submission", details, defaults)).toBe(true)
    const output = { ...defaults, test_show_output: true }
    expect(sectionIsConfigured("submission", output, defaults)).toBe(true)
    expect(sectionIsConfigured("details", output, defaults)).toBe(false)
  })
})

describe("errorKeyMatchesField", () => {
  it("matches an exact field key", () => {
    expect(errorKeyMatchesField("name", "name")).toBe(true)
    expect(errorKeyMatchesField("name", "slug")).toBe(false)
  })

  it("matches an indexed sub-key of the field", () => {
    // validateAssignmentForm keys per-test errors as "tests[0].name".
    expect(errorKeyMatchesField("tests[0].name", "tests")).toBe(true)
    expect(errorKeyMatchesField("tests[2].run", "tests")).toBe(true)
  })

  it("does not match a different field with a shared prefix", () => {
    expect(errorKeyMatchesField("submission_tags", "submission_mode")).toBe(
      false,
    )
  })
})
