import { describe, expect, it } from "vitest"
import { COMMIT_PREFIX, prefixCommit } from "./commit"

describe("commit prefix", () => {
  // Pins the literal so it can't drift from the CLI's cli/shared/contract
  // CommitPrefix and the collect-scores.yaml workflow (no compile-time link
  // across the three).
  it("uses the [Classroom 50] wire prefix", () => {
    expect(COMMIT_PREFIX).toBe("[Classroom 50]")
  })

  // Matches the CLI's contract.PrefixCommit: prefix + single space + message,
  // preserving any trailing "(gh ... )" provenance hint verbatim.
  it("prepends the prefix with a single space", () => {
    expect(
      prefixCommit(
        "Initialize .classroom50.yaml and autograde workflow (gh student accept)",
      ),
    ).toBe(
      "[Classroom 50] Initialize .classroom50.yaml and autograde workflow (gh student accept)",
    )
  })
})
