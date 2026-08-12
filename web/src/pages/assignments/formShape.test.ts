import { describe, expect, it } from "vitest"
import { deriveFormShape } from "./formShape"
import type { CreateAssignmentFormValues } from "./assignmentFormModel"

// Minimal valid form values; each test overrides only the fields under test.
const base: CreateAssignmentFormValues = {
  name: "Homework 1",
  slug: "hw1",
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
  copy_about: false,
  copy_topics: false,
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
  grading_choice: "auto",
  grading_max_points: 100,
  repo_feature_issues: "inherit",
  repo_feature_wiki: "inherit",
  repo_feature_projects: "inherit",
  repo_feature_pull_requests: "inherit",
  tests: [],
}

describe("deriveFormShape — repository source", () => {
  it("no template + README ('readme'): non-empty, template hidden, README shown, feedback available", () => {
    const shape = deriveFormShape({
      ...base,
      repo_source: "none",
      add_readme: true,
    })
    expect(shape.repositorySource).toBe("readme")
    expect(shape.emptyRepo).toBe(false)
    expect(shape.showTemplateFields).toBe(false)
    expect(shape.showAddReadme).toBe(true)
    expect(shape.feedbackPrEnabled).toBe(true)
  })

  it("no template + no README + built-in off: bare repo (empty_repo), disables feedback", () => {
    const shape = deriveFormShape({
      ...base,
      repo_source: "none",
      add_readme: false,
      autograding_state: "none",
    })
    expect(shape.repositorySource).toBe("empty")
    expect(shape.emptyRepo).toBe(true)
    expect(shape.initShim).toBe(false)
    expect(shape.noAutograder).toBe(false)
    expect(shape.autogradingState).toBe("empty")
    expect(shape.showTemplateFields).toBe(false)
    expect(shape.showAddReadme).toBe(true)
    expect(shape.feedbackPrEnabled).toBe(false)
    expect(shape.showBuiltInConfig).toBe(false)
  })

  it("no template + no README + built-in on: init_shim (not bare), built-in config + feedback available", () => {
    const shape = deriveFormShape({
      ...base,
      repo_source: "none",
      add_readme: false,
      autograding_state: "built-in",
    })
    expect(shape.repositorySource).toBe("empty")
    // Built-in on an empty source is init_shim, NOT a bare repo.
    expect(shape.initShim).toBe(true)
    expect(shape.emptyRepo).toBe(false)
    expect(shape.noAutograder).toBe(false)
    expect(shape.autogradingState).toBe("built-in")
    expect(shape.showBuiltInConfig).toBe(true)
    expect(shape.feedbackPrEnabled).toBe(true)
  })

  it("a raw empty_repo: true stays bare even with built-in on (hard override, no init_shim)", () => {
    const shape = deriveFormShape({
      ...base,
      empty_repo: true,
      autograding_state: "built-in",
    })
    expect(shape.emptyRepo).toBe(true)
    expect(shape.initShim).toBe(false)
    expect(shape.autogradingState).toBe("empty")
  })

  it("a raw empty_repo: true overrides to 'empty' (stored bare-repo assignment)", () => {
    const shape = deriveFormShape({
      ...base,
      empty_repo: true,
      autograding_state: "built-in",
    })
    expect(shape.repositorySource).toBe("empty")
    expect(shape.emptyRepo).toBe(true)
    expect(shape.autogradingState).toBe("empty")
  })

  it("template source, built-in on: template fields shown, README toggle hidden, built-in available", () => {
    const shape = deriveFormShape({
      ...base,
      repo_source: "template",
      add_readme: false,
      autograding_state: "built-in",
    })
    expect(shape.repositorySource).toBe("template")
    expect(shape.emptyRepo).toBe(false)
    expect(shape.noAutograder).toBe(false)
    expect(shape.showTemplateFields).toBe(true)
    expect(shape.showAddReadme).toBe(false)
    expect(shape.feedbackPrEnabled).toBe(true)
    expect(shape.showBuiltInConfig).toBe(true)
  })

  it("template source, built-in off: teacher-supplied CI (no_autograder), template + feedback stay", () => {
    const shape = deriveFormShape({
      ...base,
      repo_source: "template",
      autograding_state: "none",
    })
    expect(shape.autogradingState).toBe("none")
    // A template source with built-in off is the teacher-supplied-CI wire state.
    expect(shape.noAutograder).toBe(true)
    expect(shape.showBuiltInConfig).toBe(false)
    expect(shape.showTemplateFields).toBe(true)
    expect(shape.feedbackPrEnabled).toBe(true)
  })

  it("README source, built-in off: plain repo, NOT no_autograder (no template)", () => {
    const shape = deriveFormShape({
      ...base,
      repo_source: "none",
      add_readme: true,
      autograding_state: "none",
    })
    expect(shape.repositorySource).toBe("readme")
    expect(shape.emptyRepo).toBe(false)
    // no_autograder requires a template, so a README repo never sets it.
    expect(shape.noAutograder).toBe(false)
    expect(shape.autogradingState).toBe("none")
  })

  it("autograding config is offered only when grading is Autograded", () => {
    expect(
      deriveFormShape({ ...base, grading_choice: "auto" })
        .showAutogradingConfig,
    ).toBe(true)
    expect(
      deriveFormShape({ ...base, grading_choice: "manual" })
        .showAutogradingConfig,
    ).toBe(false)
    expect(
      deriveFormShape({ ...base, grading_choice: "off" }).showAutogradingConfig,
    ).toBe(false)
  })

  it("showGroupSize is true only for a group assignment", () => {
    expect(deriveFormShape({ ...base, mode: "group" }).showGroupSize).toBe(true)
    expect(deriveFormShape({ ...base, mode: "individual" }).showGroupSize).toBe(
      false,
    )
  })

  it("assignmentType mirrors mode", () => {
    expect(deriveFormShape({ ...base, mode: "group" }).assignmentType).toBe(
      "group",
    )
    expect(
      deriveFormShape({ ...base, mode: "individual" }).assignmentType,
    ).toBe("individual")
  })

  it("showContainerFields is true only in container runtime mode", () => {
    expect(
      deriveFormShape({ ...base, runtime_env: "container" })
        .showContainerFields,
    ).toBe(true)
    expect(
      deriveFormShape({ ...base, runtime_env: "hosted" }).showContainerFields,
    ).toBe(false)
  })
})
