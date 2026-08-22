import { describe, expect, it } from "vitest"
import {
  SHORT_NAME_PATTERN,
  assertValidShortName,
  isCanonicalTeamShortName,
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

describe("assertValidShortName", () => {
  it("passes a valid slug", () => {
    expect(() => assertValidShortName("cs-principles")).not.toThrow()
  })

  it("throws on an over-cap slug", () => {
    expect(() => assertValidShortName("a".repeat(101))).toThrow(
      /shortNameInvalid/,
    )
  })
})
