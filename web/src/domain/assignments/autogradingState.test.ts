import { describe, expect, it } from "vitest"

import type { Assignment } from "@/types/classroom"
import {
  assignmentSkipsGrading,
  deriveAutogradingState,
  isEmptyRepoAssignment,
  isNoAutograderAssignment,
} from "./autogradingState"

const base: Assignment = {
  slug: "hw",
  name: "HW",
  mode: "individual",
  autograder: "default",
}

describe("autogradingState predicates", () => {
  it("isEmptyRepoAssignment is strict-boolean true", () => {
    expect(isEmptyRepoAssignment({ ...base, empty_repo: true })).toBe(true)
    expect(isEmptyRepoAssignment({ ...base, empty_repo: false })).toBe(false)
    expect(isEmptyRepoAssignment(base)).toBe(false)
  })

  it("isNoAutograderAssignment is strict-boolean true", () => {
    expect(isNoAutograderAssignment({ ...base, no_autograder: true })).toBe(
      true,
    )
    expect(isNoAutograderAssignment({ ...base, no_autograder: false })).toBe(
      false,
    )
    expect(isNoAutograderAssignment(base)).toBe(false)
  })

  it("assignmentSkipsGrading unifies both no-shim states (mirrors Python skips_grading)", () => {
    expect(assignmentSkipsGrading({ ...base, empty_repo: true })).toBe(true)
    expect(assignmentSkipsGrading({ ...base, no_autograder: true })).toBe(true)
    expect(assignmentSkipsGrading(base)).toBe(false)
  })
})

describe("deriveAutogradingState (tri-state for the assignment-form IA)", () => {
  it("empty_repo wins as 'empty'", () => {
    // empty_repo is checked first: a bare repo can't autograde regardless.
    expect(deriveAutogradingState({ ...base, empty_repo: true })).toBe("empty")
  })

  it("templated no_autograder is 'none' (teacher-supplied CI)", () => {
    expect(
      deriveAutogradingState({
        ...base,
        template: { owner: "o", repo: "t", branch: "main" },
        no_autograder: true,
      }),
    ).toBe("none")
  })

  it("everything else is 'built-in'", () => {
    expect(deriveAutogradingState(base)).toBe("built-in")
  })
})
