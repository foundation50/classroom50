import { describe, expect, it } from "vitest"
import { rosterPath } from "./rosterPath"

describe("roster path", () => {
  // Pins the filename so it can't drift from the CLI's cli/shared/contract
  // RosterFilename and the Python skeleton's ROSTER_FILENAME (no compile-time
  // link across the three tools — keep byte-identical).
  it("targets roster.csv for the current name", () => {
    expect(rosterPath("cs-principles")).toBe("cs-principles/roster.csv")
  })
})
