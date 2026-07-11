import { describe, expect, it } from "vitest"
import { rosterPath, legacyRosterPath } from "./rosterPath"

describe("roster path", () => {
  // Pins the filenames so they can't drift from the CLI's cli/shared/contract
  // RosterFilename / LegacyRosterFilename and the Python skeleton's
  // ROSTER_FILENAME / LEGACY_ROSTER_FILENAME (no compile-time link across the
  // three tools — keep byte-identical).
  it("targets roster.csv for the current name", () => {
    expect(rosterPath("cs-principles")).toBe("cs-principles/roster.csv")
  })

  it("targets the legacy students.csv for the fallback", () => {
    expect(legacyRosterPath("cs-principles")).toBe("cs-principles/students.csv")
  })
})
