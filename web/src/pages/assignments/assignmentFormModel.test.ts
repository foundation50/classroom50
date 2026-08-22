import { describe, expect, it } from "vitest"
import type { TFunction } from "i18next"
import type { AssignmentTestDraft } from "@/util/assignmentTests"
import {
  assignmentToFormValues,
  validateAssignmentForm,
  toSubmitValues,
  formValuesToRepoFeatures,
  shouldSeedBuiltInAutograder,
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
  feedback_pr_template: false,
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

  it("flags a slug over the 100-char cap on create", () => {
    const errors = validateAssignmentForm({ ...base, slug: "a".repeat(101) }, t)
    expect(errors.slug).toBe("assignments.form.validation.slugInvalid")
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
        {
          ...base,
          submission_mode: "tag",
          submission_tags: "phase1\nphase2\nv*",
        },
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
      validateAssignmentForm(
        { ...base, submission_mode: "tag", submission_tags: raw },
        t,
      ).submission_tags,
    ).toBeDefined()
  })

  it("skips tag validation in every-push mode (field hidden, value ignored)", () => {
    // The tags field is only shown for "A tagged commit"; a stale invalid value
    // in every-push mode must not raise an error the teacher can't see to fix
    // (toSubmitValues clears it there anyway).
    expect(
      validateAssignmentForm(
        {
          ...base,
          submission_mode: "every-push",
          submission_tags: "has space",
        },
        t,
      ).submission_tags,
    ).toBeUndefined()
  })
})

describe("validateAssignmentForm — grading", () => {
  it("accepts off/auto without a max, and manual with a max >= 1", () => {
    for (const choice of ["off", "auto"] as const) {
      expect(
        validateAssignmentForm({ ...base, grading_choice: choice }, t)
          .grading_max_points,
      ).toBeUndefined()
    }
    expect(
      validateAssignmentForm(
        { ...base, grading_choice: "manual", grading_max_points: 1 },
        t,
      ).grading_max_points,
    ).toBeUndefined()
    expect(
      validateAssignmentForm(
        { ...base, grading_choice: "manual", grading_max_points: 100 },
        t,
      ).grading_max_points,
    ).toBeUndefined()
  })

  it("flags a hand-tampered grading choice", () => {
    expect(
      validateAssignmentForm({ ...base, grading_choice: "partial" as never }, t)
        .grading_choice,
    ).toBe("assignments.form.validation.gradingModeInvalid")
  })

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["non-integer", 2.5],
  ])("flags a manual max of %s", (_label, max) => {
    expect(
      validateAssignmentForm(
        { ...base, grading_choice: "manual", grading_max_points: max },
        t,
      ).grading_max_points,
    ).toBe("assignments.form.validation.gradingMaxPointsInvalid")
  })

  it("ignores the max when the choice is not manual", () => {
    // A stale/invalid max is not validated unless manual is selected.
    expect(
      validateAssignmentForm(
        { ...base, grading_choice: "auto", grading_max_points: 0 },
        t,
      ).grading_max_points,
    ).toBeUndefined()
  })
})

describe("toSubmitValues — grading", () => {
  it("passes the choice through and keeps the manual max", () => {
    const out = toSubmitValues({
      ...base,
      grading_choice: "manual",
      grading_max_points: 50,
    })
    expect(out.grading_choice).toBe("manual")
    expect(out.grading_max_points).toBe(50)
  })

  it("resets the max when the choice is not manual", () => {
    const out = toSubmitValues({
      ...base,
      grading_choice: "auto",
      grading_max_points: 37,
    })
    expect(out.grading_choice).toBe("auto")
    expect(out.grading_max_points).toBe(100)
  })

  it("does not clear grading for a teacher-CI (no built-in) assignment", () => {
    // grading is orthogonal to the autograding tri-state: a no-built-in repo
    // can still be graded manually, unlike submission_mode which is cleared.
    const out = toSubmitValues({
      ...base,
      autograding_state: "none",
      grading_choice: "manual",
      grading_max_points: 20,
    })
    expect(out.grading_choice).toBe("manual")
    expect(out.grading_max_points).toBe(20)
    expect(out.submission_mode).toBe("every-push")
  })
})

describe("assignmentToFormValues — grading", () => {
  it("defaults to auto when grading is absent", () => {
    const values = assignmentToFormValues({
      slug: "hw1",
      name: "Homework",
      mode: "individual",
      autograder: "default",
    })
    expect(values.grading_choice).toBe("auto")
  })

  it("reads a stored manual grading with its max", () => {
    const values = assignmentToFormValues({
      slug: "hw1",
      name: "Homework",
      mode: "individual",
      autograder: "default",
      grading: { mode: "manual", max_points: 25 },
    })
    expect(values.grading_choice).toBe("manual")
    expect(values.grading_max_points).toBe(25)
  })

  it("reads a stored off grading", () => {
    const values = assignmentToFormValues({
      slug: "hw1",
      name: "Homework",
      mode: "individual",
      autograder: "default",
      grading: { mode: "off" },
    })
    expect(values.grading_choice).toBe("off")
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
    // The submission definition is preserved even for a bare repo: it is the
    // app's detection rule (what the submissions page counts), not a shim
    // trigger, so empty_repo no longer clears it.
    expect(out.submission_mode).toBe("tag")
    expect(out.submission_tags).toBe("phase1\nphase2")
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

  it("clears built-in-only fields when the built-in autograder is off but keeps template + feedback_pr", () => {
    // A templated assignment with the built-in autograder OFF commits no shim
    // (teacher-supplied CI), so the grading-adjacent fields clear like
    // empty_repo — but unlike empty_repo it PERMITS a template and the Feedback
    // PR (a templated repo has a baseline commit).
    const out = toSubmitValues({
      ...base,
      repo_source: "template",
      autograding_state: "none",
      grading_choice: "manual",
      grading_max_points: 50,
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
    // Preserved: the submission definition is the app's detection rule, valid
    // for any repo shape (not cleared with the built-in-only autograder config).
    expect(out.submission_mode).toBe("tag")
    expect(out.submission_tags).toBe("phase1")
    expect(out.autograding_state).toBe("none")
  })

  it("clears submission_tags in every-push mode (the field is hidden there)", () => {
    // The tags field is shown only for "A tagged commit"; a stale value from a
    // prior "tag" selection must not persist once the teacher switches back to
    // every-push, so the wire matches what's visible.
    const out = toSubmitValues({
      ...base,
      submission_mode: "every-push",
      submission_tags: "phase1\nphase2",
    })
    expect(out.submission_mode).toBe("every-push")
    expect(out.submission_tags).toBe("")
  })

  it("preserves built-in autograder config under Manual grading (built-in on)", () => {
    // The built-in-only field clearing keys off the built-in autograder toggle
    // (autograding_state), NOT the grading choice — so a built-in assignment
    // graded Manually must KEEP its advanced config on submit even though the
    // (immutable) Manual choice hides the panes in the UI. Guards the invariant
    // deriveFormShape's showBuiltInConfig doc calls out.
    const out = toSubmitValues({
      ...base,
      repo_source: "template",
      template_repo: "acme/starter",
      autograding_state: "built-in",
      grading_choice: "manual",
      grading_max_points: 50,
      setup_command: "make",
      allowed_files: "*\n!hello.py",
      release_assets: "report.pdf",
      pass_threshold_enabled: true,
    })
    expect(out.autograding_state).toBe("built-in")
    expect(out.setup_command).toBe("make")
    expect(out.allowed_files).toBe("*\n!hello.py")
    expect(out.release_assets).toBe("report.pdf")
    expect(out.pass_threshold_enabled).toBe(true)
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

  it("no template + no README + built-in off maps to a bare repo (empty_repo true)", () => {
    const out = toSubmitValues({
      ...base,
      repo_source: "none",
      add_readme: false,
      autograding_state: "none",
      grading_choice: "manual",
      grading_max_points: 50,
    })
    expect(out.empty_repo).toBe(true)
  })

  it("no template + no README + built-in on is NOT bare (init_shim case; empty_repo false)", () => {
    const out = toSubmitValues({
      ...base,
      repo_source: "none",
      add_readme: false,
      autograding_state: "built-in",
      grading_choice: "auto",
    })
    // Built-in on an empty source commits a shim (init_shim), so it's not bare.
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

  it("surfaces a stored template as owner/repo, dropping any stored branch (#673)", () => {
    // A custom source branch isn't supported: the edit form always shows just
    // owner/repo, regardless of the stored (resolved-default) branch.
    const custom = assignmentToFormValues({
      slug: "hw",
      name: "HW",
      mode: "individual",
      autograder: "default",
      template: { owner: "acme", repo: "starter", branch: "spring-2026" },
    })
    expect(custom.template_repo).toBe("acme/starter")
    const mainBranch = assignmentToFormValues({
      slug: "hw2",
      name: "HW2",
      mode: "individual",
      autograder: "default",
      template: { owner: "acme", repo: "starter", branch: "main" },
    })
    expect(mainBranch.template_repo).toBe("acme/starter")
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

  it("copy_about/copy_topics pass through for a template source, clear otherwise", () => {
    const templated = toSubmitValues({
      ...base,
      repo_source: "template",
      template_repo: "acme/starter",
      copy_about: true,
      copy_topics: true,
    })
    expect(templated.copy_about).toBe(true)
    expect(templated.copy_topics).toBe(true)
    // No template -> cleared (nothing to copy from; a stale toggle can't reach
    // the wire).
    const noTemplate = toSubmitValues({
      ...base,
      repo_source: "none",
      add_readme: true,
      copy_about: true,
      copy_topics: true,
    })
    expect(noTemplate.copy_about).toBe(false)
    expect(noTemplate.copy_topics).toBe(false)
  })

  it("feedback_pr_template survives only with a template + Feedback PR on, else clears", () => {
    // Template source + Feedback PR on -> passes through.
    const on = toSubmitValues({
      ...base,
      repo_source: "template",
      template_repo: "acme/starter",
      feedback_pr: true,
      feedback_pr_template: true,
    })
    expect(on.feedback_pr_template).toBe(true)
    // Feedback PR off -> cleared (the template body has nothing to drive).
    const feedbackOff = toSubmitValues({
      ...base,
      repo_source: "template",
      template_repo: "acme/starter",
      feedback_pr: false,
      feedback_pr_template: true,
    })
    expect(feedbackOff.feedback_pr_template).toBe(false)
    // No template -> cleared (nothing to read from).
    const noTemplate = toSubmitValues({
      ...base,
      repo_source: "none",
      add_readme: true,
      feedback_pr: true,
      feedback_pr_template: true,
    })
    expect(noTemplate.feedback_pr_template).toBe(false)
  })

  it("round-trips a stored feedback_pr_template flag", () => {
    const values = assignmentToFormValues({
      slug: "hw",
      name: "HW",
      mode: "individual",
      autograder: "default",
      template: { owner: "acme", repo: "starter", branch: "main" },
      feedback_pr: true,
      feedback_pr_template: true,
    })
    expect(values.feedback_pr_template).toBe(true)
    // Absent reads back as false.
    const bare = assignmentToFormValues({
      slug: "hw2",
      name: "HW2",
      mode: "individual",
      autograder: "default",
      template: { owner: "acme", repo: "starter", branch: "main" },
    })
    expect(bare.feedback_pr_template).toBe(false)
  })

  it("round-trips stored copy_about/copy_topics flags", () => {
    const values = assignmentToFormValues({
      slug: "hw",
      name: "HW",
      mode: "individual",
      autograder: "default",
      template: { owner: "acme", repo: "starter", branch: "main" },
      copy_about: true,
      copy_topics: true,
    })
    expect(values.copy_about).toBe(true)
    expect(values.copy_topics).toBe(true)
    // Absent flags read back as false.
    const bare = assignmentToFormValues({
      slug: "hw2",
      name: "HW2",
      mode: "individual",
      autograder: "default",
      template: { owner: "acme", repo: "starter", branch: "main" },
    })
    expect(bare.copy_about).toBe(false)
    expect(bare.copy_topics).toBe(false)
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

  it("round-trips a stored templated no_autograder assignment without dropping the flag", () => {
    // A stored no_autograder (teacher-supplied CI on a template) must read back
    // as a template source with the built-in autograder off, so deriveFormShape
    // re-derives no_autograder:true — otherwise a re-save would drop the
    // immutable flag and editAssignment's guard would reject the edit. Guards
    // that noAutograder keys off the (template) source + built-in toggle, not
    // the grading choice (this assignment is graded manually).
    const values = assignmentToFormValues({
      slug: "ci",
      name: "Teacher CI",
      mode: "individual",
      autograder: "default",
      template: { owner: "acme", repo: "starter", branch: "main" },
      no_autograder: true,
      grading: { mode: "manual", max_points: 50 },
    })
    expect(values.repo_source).toBe("template")
    expect(values.autograding_state).toBe("none")
    expect(values.grading_choice).toBe("manual")
    const shape = deriveFormShape({ ...base, ...values })
    expect(shape.noAutograder).toBe(true)
    expect(shape.initShim).toBe(false)
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

describe("shouldSeedBuiltInAutograder", () => {
  const base = {
    next: "auto",
    previous: "off",
    autogradingState: "none",
    autogradingTouched: false,
  } as const

  it("seeds on first entry into Autograded", () => {
    expect(shouldSeedBuiltInAutograder(base)).toBe(true)
    // A bare repo's "empty" state is equally un-chosen.
    expect(
      shouldSeedBuiltInAutograder({ ...base, autogradingState: "empty" }),
    ).toBe(true)
  })

  it("does not seed unless entering Autograded from another mode", () => {
    expect(shouldSeedBuiltInAutograder({ ...base, next: "manual" })).toBe(false)
    expect(shouldSeedBuiltInAutograder({ ...base, next: "off" })).toBe(false)
    // Already in auto: not an entry.
    expect(shouldSeedBuiltInAutograder({ ...base, previous: "auto" })).toBe(
      false,
    )
  })

  it("never overrides a pick the teacher already made", () => {
    expect(
      shouldSeedBuiltInAutograder({ ...base, autogradingTouched: true }),
    ).toBe(false)
    expect(
      shouldSeedBuiltInAutograder({
        ...base,
        autogradingState: "built-in",
      }),
    ).toBe(false)
  })
})
