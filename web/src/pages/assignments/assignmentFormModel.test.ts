import { describe, expect, it } from "vitest"
import type { TFunction } from "i18next"
import type { AssignmentTestDraft } from "@/util/assignmentTests"
import {
  validateAssignmentForm,
  toSubmitValues,
  type CreateAssignmentFormValues,
} from "./assignmentFormModel"

// Echo the i18n key (+ any interpolation) so assertions match on stable keys.
const t = ((key: string) => key) as unknown as TFunction

// A minimal well-formed test draft; individual fields are overridden per case
// to exercise validateTestDrafts' per-index error keying.
const draft = (
  over: Partial<AssignmentTestDraft> = {},
): AssignmentTestDraft => ({
  name: "adds numbers",
  type: "run",
  setup: "",
  run: "pytest",
  input: "",
  inputFile: "",
  expected: "",
  expectedFile: "",
  comparison: "exact",
  timeout: 30,
  exitCode: "",
  points: 10,
  ...over,
})

const base: CreateAssignmentFormValues = {
  name: "Homework 1",
  slug: "hw1",
  description: "",
  mode: "individual",
  template_repo: "",
  due_date: "",
  max_group_size: 2,
  feedback_pr: true,
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
  allowed_files: "",
  pass_threshold_enabled: false,
  pass_threshold: 80,
  tests: [],
}

describe("validateAssignmentForm — happy paths", () => {
  it("a well-formed individual assignment has no errors", () => {
    expect(validateAssignmentForm(base, t)).toEqual({})
  })

  it("a well-formed group assignment with a valid size has no errors", () => {
    expect(
      validateAssignmentForm({ ...base, mode: "group", max_group_size: 4 }, t),
    ).toEqual({})
  })
})

describe("validateAssignmentForm — required fields", () => {
  it("flags a blank name", () => {
    expect(validateAssignmentForm({ ...base, name: "  " }, t).name).toBe(
      "assignments.form.validation.nameRequired",
    )
  })

  it("flags a blank slug on create", () => {
    expect(validateAssignmentForm({ ...base, slug: "" }, t).slug).toBe(
      "assignments.form.validation.slugRequired",
    )
  })

  it("does NOT validate the slug in edit mode (no rename)", () => {
    const errors = validateAssignmentForm({ ...base, slug: "" }, t, {
      edit: true,
    })
    expect(errors.slug).toBeUndefined()
  })

  it("flags a case-insensitive slug collision on create", () => {
    const errors = validateAssignmentForm({ ...base, slug: "HW1" }, t, {
      takenSlugs: ["hw1"],
    })
    expect(errors.slug).toBe("validation.assignmentSlugTaken")
  })
})

describe("validateAssignmentForm — group size", () => {
  it("flags a non-integer group size", () => {
    expect(
      validateAssignmentForm({ ...base, mode: "group", max_group_size: 2.5 }, t)
        .max_group_size,
    ).toBe("validation.groupSizeRange")
  })

  it("flags an out-of-range group size", () => {
    expect(
      validateAssignmentForm({ ...base, mode: "group", max_group_size: 999 }, t)
        .max_group_size,
    ).toBe("validation.groupSizeRange")
  })

  it("flags a zero group size as invalid", () => {
    expect(
      validateAssignmentForm({ ...base, mode: "group", max_group_size: 0 }, t)
        .max_group_size,
    ).toBe("assignments.form.validation.maxGroupSizeInvalid")
  })
})

describe("validateAssignmentForm — pass threshold", () => {
  it("ignores the threshold when disabled", () => {
    expect(
      validateAssignmentForm(
        { ...base, pass_threshold_enabled: false, pass_threshold: 999 },
        t,
      ).pass_threshold,
    ).toBeUndefined()
  })

  it("flags an out-of-range threshold when enabled", () => {
    expect(
      validateAssignmentForm(
        { ...base, pass_threshold_enabled: true, pass_threshold: 150 },
        t,
      ).pass_threshold,
    ).toBe("assignments.form.validation.passThresholdRange")
  })
})

describe("validateAssignmentForm — runtime env", () => {
  it("flags a non-Ubuntu runner label combined with a container image", () => {
    const errors = validateAssignmentForm(
      {
        ...base,
        runtime_env: "container",
        container_image: "python:3.12",
        runs_on: "macos-latest",
      },
      t,
    )
    expect(errors.runs_on).toBe("assignments.form.runtime.runnerContainerError")
  })

  it("does not validate apt in container mode", () => {
    // An apt value that would be invalid in hosted mode is ignored in container
    // mode (the submit path clears it).
    const errors = validateAssignmentForm(
      {
        ...base,
        runtime_env: "container",
        container_image: "python:3.12",
        runtime_apt: "bad;;value",
      },
      t,
    )
    expect(errors.runtime_apt).toBeUndefined()
  })

  it("flags a malformed container image and user (CLI injection-shape gate)", () => {
    const errors = validateAssignmentForm(
      {
        ...base,
        runtime_env: "container",
        container_image: "bad image; rm -rf /",
        container_user: "not a user!",
      },
      t,
    )
    expect(errors.container_image).toBeDefined()
    expect(errors.container_user).toBeDefined()
  })

  it("validates apt in hosted mode", () => {
    const errors = validateAssignmentForm(
      { ...base, runtime_env: "hosted", runtime_apt: "bad;;value" },
      t,
    )
    expect(errors.runtime_apt).toBeDefined()
  })

  it("flags a malformed language toolchain version, keyed per language", () => {
    const errors = validateAssignmentForm(
      { ...base, runtime_python: "not a version!" },
      t,
    )
    expect(errors.runtime_python).toBeDefined()
    expect(errors.runtime_node).toBeUndefined()
  })
})

// The validator delegates to two shared helpers and folds their results into
// the same error map — these prove the parse-then-merge wiring, which the
// per-field cases above don't touch.
describe("validateAssignmentForm — delegated helpers", () => {
  it("merges validateTestDrafts errors under a per-index key", () => {
    const errors = validateAssignmentForm(
      { ...base, tests: [draft({ name: "  " })] },
      t,
    )
    expect(errors["tests[0].name"]).toBeDefined()
  })

  it("folds a validateAllowedFiles error under errors.allowed_files", () => {
    // A NUL survives parseAllowedFiles (only blank lines are dropped), so it
    // reaches validateAllowedFiles' shape check.
    const errors = validateAssignmentForm(
      { ...base, allowed_files: "*\n\u0000" },
      t,
    )
    expect(errors.allowed_files).toBeDefined()
  })
})

describe("toSubmitValues — runtime field clearing", () => {
  it("clears container fields + trims in hosted mode", () => {
    const out = toSubmitValues({
      ...base,
      name: "  Homework 1  ",
      runtime_env: "hosted",
      container_image: "python:3.12",
      container_user: "root",
      runtime_apt: " make ",
    })
    expect(out.name).toBe("Homework 1")
    expect(out.container_image).toBe("")
    expect(out.container_user).toBe("")
    expect(out.runtime_apt).toBe("make")
  })

  it("clears apt but keeps container image/user in container mode", () => {
    const out = toSubmitValues({
      ...base,
      runtime_env: "container",
      container_image: " python:3.12 ",
      container_user: " root ",
      runtime_apt: "make",
    })
    expect(out.runtime_apt).toBe("")
    expect(out.container_image).toBe("python:3.12")
    expect(out.container_user).toBe("root")
  })
})
