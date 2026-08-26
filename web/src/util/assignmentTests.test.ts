import { describe, expect, it } from "vitest"
import { draftToTest, emptyTestDraft, testToDraft } from "./assignmentTests"
import type { AssignmentTest } from "@/types/classroom"

// The reporting options (failure-details / show-output, issues #612/#764/#765)
// must survive the web draft round-trip — testToDraft/draftToTest rebuild
// every field, so an unmapped key would be silently stripped on any web edit.
describe("test draft round-trip of the reporting options", () => {
  it("defaults to inherit ('') on the empty draft and omits the keys on the wire", () => {
    const draft = emptyTestDraft()
    expect(draft.failureDetails).toBe("")
    expect(draft.showOutput).toBe("")
    const test = draftToTest({ ...draft, name: "t", run: "true" })
    expect("failure-details" in test).toBe(false)
    expect("show-output" in test).toBe(false)
  })

  it("round-trips explicit values, including show-output false", () => {
    // An explicit false overrides an assignment-level show-output default of
    // true, so it must reach the wire — absent and false are distinct.
    const test: AssignmentTest = {
      name: "t",
      type: "run",
      run: "true",
      points: 1,
      "failure-details": "actual-only",
      "show-output": false,
    }
    const draft = testToDraft(test)
    expect(draft.failureDetails).toBe("actual-only")
    expect(draft.showOutput).toBe(false)
    const again = draftToTest(draft)
    expect(again["failure-details"]).toBe("actual-only")
    expect(again["show-output"]).toBe(false)
  })

  it("round-trips show-output true on every test type", () => {
    for (const test of [
      { name: "r", type: "run", run: "true", points: 1 },
      {
        name: "i",
        type: "io",
        run: "echo hi",
        expected: "hi",
        comparison: "included",
        points: 1,
      },
      { name: "p", type: "python", run: "pytest", points: 1 },
    ] satisfies AssignmentTest[]) {
      const withOptions: AssignmentTest = {
        ...test,
        "failure-details": "none",
        "show-output": true,
      }
      const again = draftToTest(testToDraft(withOptions))
      expect(again["failure-details"]).toBe("none")
      expect(again["show-output"]).toBe(true)
    }
  })

  it("keeps absent reporting options absent through a round-trip", () => {
    const test: AssignmentTest = {
      name: "t",
      type: "run",
      run: "true",
      points: 1,
    }
    const again = draftToTest(testToDraft(test))
    expect("failure-details" in again).toBe(false)
    expect("show-output" in again).toBe(false)
  })
})
