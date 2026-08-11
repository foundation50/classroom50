import { describe, expect, it } from "vitest"
import type { TFunction } from "i18next"
import type { AssignmentTestDraft } from "@/util/assignmentTests"
import {
  assignmentToFormValues,
  validateAssignmentForm,
  toSubmitValues,
  formValuesToRepoFeatures,
  type CreateAssignmentFormValues,
} from "./assignmentFormModel"
import { deriveFormShape } from "./formShape"

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

describe("setup timeout", () => {
  it("uses 120 seconds when the assignment has no setup test", () => {
    const values = assignmentToFormValues({
      slug: "hw1",
      name: "Homework",
      mode: "individual",
      autograder: "default",
    })

    expect(values.setup_command).toBe("")
    expect(values.setup_timeout).toBe(120)
  })

  it.each([
    ["omitted", undefined, 0],
    ["explicit zero", 0, 0],
    ["positive", 600, 600],
  ] as const)(
    "lifts a leading setup test with %s timeout",
    (_label, timeout, expected) => {
      const values = assignmentToFormValues({
        slug: "hw1",
        name: "Homework",
        mode: "individual",
        autograder: "default",
        tests: [
          {
            name: "setup",
            type: "run",
            run: "python3 -m pip install -e .",
            points: 0,
            ...(timeout === undefined ? {} : { timeout }),
          },
        ],
      })

      expect(values.setup_command).toBe("python3 -m pip install -e .")
      expect(values.setup_timeout).toBe(expected)
      expect(values.tests).toEqual([])
    },
  )

  it.each([Number.NaN, -1, 1.5, 601])(
    "rejects %s when a setup command is present",
    (setup_timeout) => {
      expect(
        validateAssignmentForm(
          { ...base, setup_command: "make", setup_timeout },
          t,
        ).setup_timeout,
      ).toBe("assignments.form.validation.setupTimeoutRange")
    },
  )

  it("ignores stale timeout values when setup does not apply", () => {
    expect(
      validateAssignmentForm(
        { ...base, setup_command: "  ", setup_timeout: 601 },
        t,
      ).setup_timeout,
    ).toBeUndefined()
    expect(
      validateAssignmentForm(
        {
          ...base,
          empty_repo: true,
          setup_command: "make",
          setup_timeout: 601,
        },
        t,
      ).setup_timeout,
    ).toBeUndefined()
  })
})

describe("validateAssignmentForm — runtime env", () => {
  it("flags a non-Ubuntu runner label combined with a container image", () => {
    const errors = validateAssignmentForm(
      {
        ...base,
        runtime_env: "container",
        container_image: "python:3.14",
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
        container_image: "python:3.14",
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

describe("validateAssignmentForm — submission mode + milestone tags", () => {
  it("accepts the two valid submission modes", () => {
    expect(
      validateAssignmentForm({ ...base, submission_mode: "tag" }, t)
        .submission_mode,
    ).toBeUndefined()
    expect(
      validateAssignmentForm({ ...base, submission_mode: "every-push" }, t)
        .submission_mode,
    ).toBeUndefined()
  })

  it("flags a hand-tampered submission mode", () => {
    expect(
      validateAssignmentForm(
        { ...base, submission_mode: "on-demand" as never },
        t,
      ).submission_mode,
    ).toBe("assignments.form.validation.submissionModeInvalid")
  })

  it("accepts valid milestone tag patterns", () => {
    expect(
      validateAssignmentForm(
        { ...base, submission_tags: "phase1\nphase2\nv*" },
        t,
      ).submission_tags,
    ).toBeUndefined()
  })

  it.each([
    ["exclude pattern", "!v*"],
    ["charset violation (quote)", 'ta"g'],
    ["whitespace", "has space"],
    ["stacked quantifier", "v*+"],
    ["duplicate", "phase1\nphase1"],
  ])("flags an invalid milestone tag: %s", (_label, raw) => {
    expect(
      validateAssignmentForm({ ...base, submission_tags: raw }, t)
        .submission_tags,
    ).toBeDefined()
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
      container_image: "python:3.14",
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
      container_image: " python:3.14 ",
      container_user: " root ",
      runtime_apt: "make",
    })
    expect(out.runtime_apt).toBe("")
    expect(out.container_image).toBe("python:3.14")
    expect(out.container_user).toBe("root")
  })

  it("clears every grading-adjacent field for an empty repo", () => {
    const out = toSubmitValues({
      ...base,
      empty_repo: true,
      template_repo: "acme/starter",
      feedback_pr: true,
      setup_command: "make setup",
      setup_timeout: 600,
      allowed_files: "*\n!hello.py",
      pass_threshold_enabled: true,
      submission_mode: "tag",
      submission_tags: "phase1\nphase2",
      release_assets: "report.pdf",
      tests: [{ name: "t", run: "pytest", points: 1 } as never],
    })
    expect(out.empty_repo).toBe(true)
    expect(out.template_repo).toBe("")
    expect(out.feedback_pr).toBe(false)
    expect(out.setup_command).toBe("")
    expect(out.setup_timeout).toBe(0)
    expect(out.allowed_files).toBe("")
    expect(out.pass_threshold_enabled).toBe(false)
    expect(out.tests).toEqual([])
    // The two newest grading-trigger fields must also clear for a bare repo
    // (no shim to trigger) — pins the empty-repo clear set the autograding
    // restructure reproduces.
    expect(out.submission_mode).toBe("every-push")
    expect(out.submission_tags).toBe("")
    expect(out.release_assets).toBe("")
  })

  it("passes group provisioning and submission fields through for a non-empty repo", () => {
    // The complement of the empty-repo clear: a normal assignment keeps its
    // group size, submission mode, and milestone tags. Pins the fields the
    // restructure must NOT clear when the repo is non-empty.
    const out = toSubmitValues({
      ...base,
      mode: "group",
      max_group_size: 4,
      student_permission: "admin",
      submission_mode: "tag",
      submission_tags: "phase1\nphase2",
    })
    expect(out.max_group_size).toBe(4)
    expect(out.student_permission).toBe("admin")
    expect(out.submission_mode).toBe("tag")
    expect(out.submission_tags).toBe("phase1\nphase2")
  })

  it("clears built-in-only fields for the 'none' autograding state but keeps template + feedback_pr", () => {
    // "none" (teacher-supplied CI) commits no shim, so the grading-adjacent
    // fields clear like empty_repo — but unlike empty_repo it PERMITS a
    // template and the Feedback PR (a templated repo has a baseline commit).
    const out = toSubmitValues({
      ...base,
      repo_source: "template",
      autograding_state: "none",
      template_repo: "acme/starter",
      feedback_pr: true,
      setup_command: "make",
      allowed_files: "*\n!hello.py",
      release_assets: "report.pdf",
      pass_threshold_enabled: true,
      submission_mode: "tag",
      submission_tags: "phase1",
    })
    // Permitted (the asymmetry vs empty_repo):
    expect(out.template_repo).toBe("acme/starter")
    expect(out.feedback_pr).toBe(true)
    // Cleared (no shim to run/trigger):
    expect(out.setup_command).toBe("")
    expect(out.allowed_files).toBe("")
    expect(out.release_assets).toBe("")
    expect(out.pass_threshold_enabled).toBe(false)
    expect(out.submission_mode).toBe("every-push")
    expect(out.submission_tags).toBe("")
    expect(out.autograding_state).toBe("none")
  })

  it("empty_repo forces the autograding state to 'empty' regardless of the picked value", () => {
    const out = toSubmitValues({
      ...base,
      empty_repo: true,
      autograding_state: "built-in",
    })
    expect(out.autograding_state).toBe("empty")
  })

  it("no template + README maps to a non-empty repo (empty_repo false), template cleared", () => {
    const out = toSubmitValues({
      ...base,
      repo_source: "none",
      add_readme: true,
      template_repo: "acme/starter",
    })
    expect(out.empty_repo).toBe(false)
    expect(out.template_repo).toBe("")
  })

  it("no template + no README + none maps to a bare repo (empty_repo true)", () => {
    const out = toSubmitValues({
      ...base,
      repo_source: "none",
      add_readme: false,
      autograding_state: "none",
    })
    expect(out.empty_repo).toBe(true)
  })

  it("no template + no README + built-in is NOT bare (init_shim case; empty_repo false)", () => {
    const out = toSubmitValues({
      ...base,
      repo_source: "none",
      add_readme: false,
      autograding_state: "built-in",
    })
    // Built-in on an empty source commits a shim (init_shim), so it is not bare.
    expect(out.empty_repo).toBe(false)
    expect(out.autograding_state).toBe("built-in")
  })

  it("template source keeps the template and is never empty", () => {
    const out = toSubmitValues({
      ...base,
      repo_source: "template",
      add_readme: false,
      template_repo: "acme/starter",
    })
    expect(out.empty_repo).toBe(false)
    expect(out.template_repo).toBe("acme/starter")
  })

  it("include_all_branches passes through for a template source, clears otherwise", () => {
    const templated = toSubmitValues({
      ...base,
      repo_source: "template",
      template_repo: "acme/starter",
      include_all_branches: true,
    })
    expect(templated.include_all_branches).toBe(true)
    // No template -> cleared (a stale toggle can't reach the wire).
    const noTemplate = toSubmitValues({
      ...base,
      repo_source: "none",
      add_readme: true,
      include_all_branches: true,
    })
    expect(noTemplate.include_all_branches).toBe(false)
  })

  it("round-trips a stored init_shim assignment without flipping the flag", () => {
    // A stored init_shim (no template, empty_repo false) must read back as the
    // no-README + built-in combination so deriveFormShape re-derives init_shim
    // — NOT as a README repo, which would try to flip the immutable flag.
    const values = assignmentToFormValues({
      slug: "scratch",
      name: "Scratch",
      mode: "individual",
      autograder: "default",
      init_shim: true,
    })
    expect(values.repo_source).toBe("none")
    expect(values.add_readme).toBe(false)
    expect(values.autograding_state).toBe("built-in")
    const shape = deriveFormShape({ ...base, ...values })
    expect(shape.initShim).toBe(true)
    expect(shape.emptyRepo).toBe(false)
  })
})

describe("assignmentToFormValues — autograding tri-state", () => {
  it("derives 'built-in' for a default-autograder assignment", () => {
    const values = assignmentToFormValues({
      slug: "hw1",
      name: "Homework",
      mode: "individual",
      autograder: "default",
    })
    expect(values.autograding_state).toBe("built-in")
  })

  it("derives 'none' for a no_autograder assignment", () => {
    const values = assignmentToFormValues({
      slug: "hw1",
      name: "Homework",
      mode: "individual",
      autograder: "default",
      no_autograder: true,
    })
    expect(values.autograding_state).toBe("none")
  })

  it("derives 'empty' for an empty_repo assignment", () => {
    const values = assignmentToFormValues({
      slug: "hw1",
      name: "Homework",
      mode: "individual",
      autograder: "default",
      empty_repo: true,
    })
    expect(values.autograding_state).toBe("empty")
  })
})

describe("release_assets", () => {
  it("maps stored exact paths to textarea text in order", () => {
    const values = assignmentToFormValues({
      slug: "hw1",
      name: "Homework",
      mode: "individual",
      autograder: "default",
      release_assets: ["report.pdf", "plots/chart.png"],
    })
    expect(values.release_assets).toBe("report.pdf\nplots/chart.png")
  })

  it.each([
    [
      Array.from({ length: 51 }, (_, i) => `f${i}.pdf`).join("\n"),
      "assignments.form.validation.releaseAssetsTooMany",
    ],
    [
      `${"a/".repeat(4094)}a.pdf`,
      "assignments.form.validation.releaseAssetsTooLarge",
    ],
    ["../report.pdf", "assignments.form.validation.releaseAssetsInvalidPath"],
    ["*.pdf", "assignments.form.validation.releaseAssetsInvalidBasename"],
    [
      "a/report.pdf\nb/report.pdf",
      "assignments.form.validation.releaseAssetsDuplicateBasename",
    ],
    [
      "a/report.pdf\na/report.pdf",
      "assignments.form.validation.releaseAssetsDuplicatePath",
    ],
  ])("uses a stable locale key for %s", (raw, key) => {
    expect(
      validateAssignmentForm({ ...base, release_assets: raw }, t)
        .release_assets,
    ).toBe(key)
  })

  it("ignores and clears a hidden stale value for empty_repo", () => {
    const value = { ...base, empty_repo: true, release_assets: "../bad.pdf" }
    expect(validateAssignmentForm(value, t).release_assets).toBeUndefined()
    expect(toSubmitValues(value).release_assets).toBe("")
  })
})

describe("available_from (release date)", () => {
  it("maps a stored UTC instant back to a datetime-local value", () => {
    const values = assignmentToFormValues({
      slug: "hw1",
      name: "Homework",
      mode: "individual",
      autograder: "default",
      available_from: "2026-09-01T12:00:00Z",
    })
    // A datetime-local wall-clock value (no zone suffix), non-empty.
    expect(values.available_from_date).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
    )
  })

  it("leaves the field empty when no release date is stored", () => {
    const values = assignmentToFormValues({
      slug: "hw1",
      name: "Homework",
      mode: "individual",
      autograder: "default",
    })
    expect(values.available_from_date).toBe("")
  })
  it("trims the field on submit", () => {
    expect(
      toSubmitValues({ ...base, available_from_date: " 2026-09-01T12:00 " })
        .available_from_date,
    ).toBe("2026-09-01T12:00")
  })
})

describe("repo_features tri-state round-trip", () => {
  it("reads absent object/key -> inherit, true -> on, false -> off", () => {
    const values = assignmentToFormValues({
      slug: "hw1",
      name: "Homework",
      mode: "individual",
      autograder: "default",
      repo_features: { issues: true, wiki: false, pull_requests: true },
    })
    expect(values.repo_feature_issues).toBe("on")
    expect(values.repo_feature_wiki).toBe("off")
    expect(values.repo_feature_pull_requests).toBe("on")
    // Absent key inherits.
    expect(values.repo_feature_projects).toBe("inherit")
  })

  it("defaults all to inherit when no repo_features is stored", () => {
    const values = assignmentToFormValues({
      slug: "hw1",
      name: "Homework",
      mode: "individual",
      autograder: "default",
    })
    expect(values.repo_feature_issues).toBe("inherit")
    expect(values.repo_feature_wiki).toBe("inherit")
    expect(values.repo_feature_projects).toBe("inherit")
    expect(values.repo_feature_pull_requests).toBe("inherit")
  })

  it("writes on -> true, off -> false, and omits inherit keys", () => {
    expect(
      formValuesToRepoFeatures({
        repo_feature_issues: "on",
        repo_feature_wiki: "off",
        repo_feature_projects: "inherit",
        repo_feature_pull_requests: "off",
      }),
    ).toEqual({ issues: true, wiki: false, pull_requests: false })
  })

  it("returns undefined when all inherit (omit the block entirely)", () => {
    expect(
      formValuesToRepoFeatures({
        repo_feature_issues: "inherit",
        repo_feature_wiki: "inherit",
        repo_feature_projects: "inherit",
        repo_feature_pull_requests: "inherit",
      }),
    ).toBeUndefined()
  })

  it("round-trips a stored off without reverting to inherit", () => {
    const stored = { issues: false as const }
    const values = assignmentToFormValues({
      slug: "hw1",
      name: "Homework",
      mode: "individual",
      autograder: "default",
      repo_features: stored,
    })
    expect(values.repo_feature_issues).toBe("off")
    expect(
      formValuesToRepoFeatures({
        repo_feature_issues: values.repo_feature_issues ?? "inherit",
        repo_feature_wiki: values.repo_feature_wiki ?? "inherit",
        repo_feature_projects: values.repo_feature_projects ?? "inherit",
        repo_feature_pull_requests:
          values.repo_feature_pull_requests ?? "inherit",
      }),
    ).toEqual({ issues: false })
  })
})
