import { describe, expect, it } from "vitest"
import {
  SHORT_NAME_PATTERN,
  isCanonicalTeamShortName,
  isValidShortName,
  reservedShortNameSuffix,
} from "./shortName"

describe("SHORT_NAME_PATTERN", () => {
  it("accepts a slug at the 100-char cap", () => {
    expect(SHORT_NAME_PATTERN.test("a" + "b".repeat(99))).toBe(true)
  })

  it("rejects a 101-char slug", () => {
    expect(SHORT_NAME_PATTERN.test("a" + "b".repeat(100))).toBe(false)
  })

  it("rejects a single char (2-char minimum)", () => {
    expect(SHORT_NAME_PATTERN.test("a")).toBe(false)
  })

  it("rejects uppercase, punctuation, and a leading hyphen", () => {
    expect(SHORT_NAME_PATTERN.test("CS-50")).toBe(false)
    expect(SHORT_NAME_PATTERN.test("cs_50")).toBe(false)
    expect(SHORT_NAME_PATTERN.test("-cs50")).toBe(false)
  })
})

describe("isCanonicalTeamShortName", () => {
  it("rejects trailing or consecutive hyphens", () => {
    expect(isCanonicalTeamShortName("cs-")).toBe(false)
    expect(isCanonicalTeamShortName("cs--50")).toBe(false)
    expect(isCanonicalTeamShortName("cs-50")).toBe(true)
  })
})

describe("isValidShortName", () => {
  it("is true only when the pattern and the canonical-team form both hold", () => {
    expect(isValidShortName("cs-50")).toBe(true)
    expect(isValidShortName("a".repeat(101))).toBe(false) // over cap
    expect(isValidShortName("cs--50")).toBe(false) // non-canonical
    expect(isValidShortName("CS-50")).toBe(false) // uppercase
  })
})

describe("reservedShortNameSuffix", () => {
  it("names the staff role a short name ends in, as a whole hyphen segment", () => {
    // `ml-ta`'s student team would sit at `ml`'s TA slug.
    expect(reservedShortNameSuffix("ml-ta")).toBe("ta")
    expect(reservedShortNameSuffix("ml-hta")).toBe("hta")
    expect(reservedShortNameSuffix("ml-teacher")).toBe("teacher")
    expect(reservedShortNameSuffix("cs-101-ta")).toBe("ta")
  })

  it("leaves a name that merely contains or ends in the letters alone", () => {
    for (const ok of ["cs", "data", "delta-tab", "teachers", "hta1", "ta-cs"]) {
      expect(reservedShortNameSuffix(ok), ok).toBeNull()
    }
  })
})
