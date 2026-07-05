import type {
  AssignmentTest,
  AssignmentTestComparison,
  AssignmentTestType,
} from "@/types/classroom"

// Form-side draft for one declarative test. Camel-cased and all-fields-present
// so it plugs into @tanstack/react-form cleanly; `draftToTest` converts to the
// kebab-case v1 wire shape and drops fields that don't apply to the type.
export type AssignmentTestDraft = {
  name: string
  type: AssignmentTestType
  setup: string
  run: string
  input: string
  inputFile: string
  expected: string
  expectedFile: string
  comparison: AssignmentTestComparison
  timeout: number
  exitCode: number | ""
  points: number
}

// A setup command is encoded as a leading 0-point `run` test with this reserved
// name — the CLI-blessed pre-grading idiom (the runner runs tests in order,
// non-zero exit fails). Reserved from user tests so a graded "setup" can't be
// confused with the synthesized one.
export const SETUP_TEST_NAME = "setup"

export const makeSetupTest = (command: string): AssignmentTest => ({
  name: SETUP_TEST_NAME,
  type: "run",
  run: command,
  points: 0,
})

// Identifies the synthesized setup test by full signature (reserved name, `run`,
// 0 points); the caller checks position (always leading). Takes the common
// fields so the wire shape and the form draft can both use it.
export const isSetupTest = (test: {
  name: string
  type: AssignmentTestType
  points: number
}): boolean =>
  test.name === SETUP_TEST_NAME && test.type === "run" && test.points === 0

export const emptyTestDraft = (): AssignmentTestDraft => ({
  name: "",
  type: "io",
  setup: "",
  run: "",
  input: "",
  inputFile: "",
  expected: "",
  expectedFile: "",
  comparison: "included",
  timeout: 0,
  exitCode: "",
  points: 10,
})

export const testToDraft = (test: AssignmentTest): AssignmentTestDraft => ({
  name: test.name,
  type: test.type,
  setup: test.setup ?? "",
  run: test.run,
  input: test.input ?? "",
  inputFile: test["input-file"] ?? "",
  expected: test.expected ?? "",
  expectedFile: test["expected-file"] ?? "",
  comparison: test.comparison ?? "included",
  timeout: test.timeout ?? 0,
  exitCode: test["exit-code"] ?? "",
  points: test.points,
})

// draftToTest serializes a draft into the exact v1 wire shape: kebab-case keys,
// type-inapplicable fields dropped (the CLI rejects e.g. `expected` on a run
// test), optional fields omitted when empty/zero — the same normalized form
// `gh teacher assignment test add` writes.
export function draftToTest(draft: AssignmentTestDraft): AssignmentTest {
  const test: AssignmentTest = {
    name: draft.name.trim(),
    type: draft.type,
    run: draft.run.trim(),
    points: draft.points,
  }

  if (draft.setup.trim()) test.setup = draft.setup.trim()
  if (draft.timeout > 0) test.timeout = draft.timeout

  // Commands and file names are trimmed; stdin and expected output are written
  // raw (leading/trailing whitespace and newlines are meaningful there), only
  // their *emptiness* judged trimmed.
  if (draft.type === "io") {
    test.comparison = draft.comparison
    if (draft.input.trim() && !draft.inputFile.trim()) test.input = draft.input
    if (draft.inputFile.trim()) test["input-file"] = draft.inputFile.trim()
    if (draft.expected.trim() && !draft.expectedFile.trim())
      test.expected = draft.expected
    if (draft.expectedFile.trim())
      test["expected-file"] = draft.expectedFile.trim()
  }

  if (draft.type === "run" && draft.exitCode !== "") {
    test["exit-code"] = draft.exitCode
  }

  return test
}

const TEST_NAME_MAX_BYTES = 100
const TIMEOUT_MAX_SECONDS = 600
const POINTS_MAX = 1000
const EXIT_CODE_MAX = 255

const byteLength = (value: string) => new TextEncoder().encode(value).length

const hasControlChars = (value: string) =>
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f]/.test(value)

// validateTestDraft mirrors the rules gh-teacher enforces at write time
// (cli/gh-teacher/tests.go, pinned by schemas/assignments-v1.schema.json),
// including the two JSON Schema can't express: unique names and a 100-UTF-8-byte
// name cap. Returns one message per offending field, keyed for
// `tests[index].<field>` form errors.
export function validateTestDraft(
  draft: AssignmentTestDraft,
  otherNames: string[],
): Partial<Record<keyof AssignmentTestDraft, string>> {
  const errors: Partial<Record<keyof AssignmentTestDraft, string>> = {}
  const name = draft.name.trim()

  if (!name) {
    errors.name = "Test name is required."
  } else if (byteLength(name) > TEST_NAME_MAX_BYTES) {
    errors.name = `Test name must be at most ${TEST_NAME_MAX_BYTES} bytes (UTF-8).`
  } else if (hasControlChars(name)) {
    errors.name = "Test name must not contain control characters."
  } else if (name === SETUP_TEST_NAME) {
    errors.name = `"${SETUP_TEST_NAME}" is reserved — use the Setup Command field instead.`
  } else if (otherNames.includes(name)) {
    errors.name = "Test names must be unique within an assignment."
  }

  if (!draft.run.trim()) {
    errors.run = "Run command is required."
  }

  if (
    !Number.isInteger(draft.points) ||
    draft.points < 0 ||
    draft.points > POINTS_MAX
  ) {
    errors.points = `Points must be a whole number between 0 and ${POINTS_MAX}.`
  }

  if (
    !Number.isInteger(draft.timeout) ||
    draft.timeout < 0 ||
    draft.timeout > TIMEOUT_MAX_SECONDS
  ) {
    errors.timeout = `Timeout must be 0 (use the 10s default) or a whole number of seconds up to ${TIMEOUT_MAX_SECONDS}.`
  }

  if (draft.type === "io") {
    if (draft.input.trim() && draft.inputFile.trim()) {
      errors.inputFile = "Provide inline input or an input file, not both."
    }
    if (draft.expected.trim() && draft.expectedFile.trim()) {
      errors.expectedFile =
        "Provide inline expected output or an expected file, not both."
    }
    // `included`/`regex` against an empty (or whitespace-only) expected match
    // almost everything — an always-passing test, so reject it here like the CLI
    // does at write time.
    if (
      draft.comparison !== "exact" &&
      !draft.expected.trim() &&
      !draft.expectedFile.trim()
    ) {
      errors.expected = `Expected output is required for the "${draft.comparison}" comparison (an empty expected would match everything).`
    }
  }

  if (
    draft.type === "run" &&
    draft.exitCode !== "" &&
    (!Number.isInteger(draft.exitCode) ||
      draft.exitCode < 0 ||
      draft.exitCode > EXIT_CODE_MAX)
  ) {
    errors.exitCode = `Exit code must be a whole number between 0 and ${EXIT_CODE_MAX}.`
  }

  return errors
}

// validateTestDrafts validates the whole list, returning a flat map of
// `tests[i].<field>` -> message (the key shape @tanstack/react-form expects for
// array-field errors).
export function validateTestDrafts(
  drafts: AssignmentTestDraft[],
): Record<string, string> {
  const errors: Record<string, string> = {}
  drafts.forEach((draft, index) => {
    const otherNames = drafts
      .filter((_, i) => i !== index)
      .map((d) => d.name.trim())
    for (const [field, message] of Object.entries(
      validateTestDraft(draft, otherNames),
    )) {
      errors[`tests[${index}].${field}`] = message
    }
  })
  return errors
}
