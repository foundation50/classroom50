import { describe, expect, it } from "vitest"

import type { Assignment } from "@/types/classroom"
import {
  assignmentSetupInfo,
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
    // An init_shim assignment is NOT empty_repo — accept.ts routes it to the
    // initialized (auto_init) create path via `bare: isEmptyRepo`, so this
    // must stay false or an init_shim repo would be provisioned bare (no shim).
    expect(isEmptyRepoAssignment({ ...base, init_shim: true })).toBe(false)
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

  it("init_shim reads as 'built-in' (it commits the default shim and autogrades)", () => {
    // init_shim sets neither empty_repo nor no_autograder, so the derived
    // tri-state is built-in — the form opens on the built-in option.
    expect(deriveAutogradingState({ ...base, init_shim: true })).toBe(
      "built-in",
    )
    // And it does NOT skip grading (unlike empty_repo / no_autograder).
    expect(assignmentSkipsGrading({ ...base, init_shim: true })).toBe(false)
  })
})

describe("assignmentSetupInfo (badge + detail keys)", () => {
  it("empty_repo -> 'No template', info tone, empty detail, no template", () => {
    const info = assignmentSetupInfo({ ...base, empty_repo: true })
    expect(info.state).toBe("empty")
    expect(info.hasTemplate).toBe(false)
    expect(info.tone).toBe("info")
    expect(info.badgeKey).toBe("submissions.setup.badgeEmpty")
    expect(info.detailKey).toBe("submissions.setup.detailEmpty")
  })

  it("templated no_autograder -> 'Template · custom CI', info tone", () => {
    const info = assignmentSetupInfo({
      ...base,
      template: { owner: "o", repo: "t", branch: "main" },
      no_autograder: true,
    })
    expect(info.state).toBe("none")
    expect(info.hasTemplate).toBe(true)
    expect(info.tone).toBe("info")
    expect(info.badgeKey).toBe("submissions.setup.badgeCustomCi")
    expect(info.detailKey).toBe("submissions.setup.detailCustomCi")
  })

  it("built-in with a template -> 'Template', neutral tone", () => {
    const info = assignmentSetupInfo({
      ...base,
      template: { owner: "o", repo: "t", branch: "main" },
    })
    expect(info.state).toBe("built-in")
    expect(info.hasTemplate).toBe(true)
    expect(info.tone).toBe("neutral")
    expect(info.badgeKey).toBe("submissions.setup.badgeTemplate")
    expect(info.detailKey).toBe("submissions.setup.detailTemplate")
  })

  it("built-in template-less (init_shim) -> 'Built-in autograder', neutral tone", () => {
    const info = assignmentSetupInfo({ ...base, init_shim: true })
    expect(info.state).toBe("built-in")
    expect(info.hasTemplate).toBe(false)
    expect(info.tone).toBe("neutral")
    expect(info.badgeKey).toBe("submissions.setup.badgeBuiltIn")
    expect(info.detailKey).toBe("submissions.setup.detailBuiltIn")
  })
})
