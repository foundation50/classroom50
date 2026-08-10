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

describe("deriveFormShape", () => {
  it("empty_repo forces the empty source and empty autograding, disabling grading + feedback + template", () => {
    // empty_repo wins even over a stale "built-in" pick on the radios.
    const shape = deriveFormShape({
      ...base,
      empty_repo: true,
      autograding_state: "built-in",
    })
    expect(shape.repositorySource).toBe("empty")
    expect(shape.autogradingState).toBe("empty")
    expect(shape.showTemplateFields).toBe(false)
    expect(shape.feedbackPrEnabled).toBe(false)
    expect(shape.showBuiltInConfig).toBe(false)
  })

  it("a templated default-autograder assignment is built-in with template + feedback available", () => {
    const shape = deriveFormShape({
      ...base,
      empty_repo: false,
      autograding_state: "built-in",
    })
    expect(shape.repositorySource).toBe("template-or-blank")
    expect(shape.autogradingState).toBe("built-in")
    expect(shape.showTemplateFields).toBe(true)
    expect(shape.feedbackPrEnabled).toBe(true)
    expect(shape.showBuiltInConfig).toBe(true)
  })

  it("a teacher-supplied-CI assignment is 'none': no built-in config, but template + feedback stay available", () => {
    const shape = deriveFormShape({
      ...base,
      empty_repo: false,
      autograding_state: "none",
    })
    expect(shape.autogradingState).toBe("none")
    expect(shape.showBuiltInConfig).toBe(false)
    // The asymmetry vs empty_repo: "none" keeps the template + Feedback PR.
    expect(shape.showTemplateFields).toBe(true)
    expect(shape.feedbackPrEnabled).toBe(true)
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
