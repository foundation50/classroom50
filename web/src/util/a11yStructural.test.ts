import { describe, expect, it } from "vitest"

import {
  documentHasLang,
  fitsViewportWidth,
  hasNoSkippedHeadingLevels,
  hasSingleH1,
  meetsTargetSize,
} from "./a11yStructural"

describe("a11yStructural predicates", () => {
  it("hasSingleH1: exactly one h1", () => {
    expect(hasSingleH1([1, 2, 2, 3])).toBe(true)
    expect(hasSingleH1([1, 1])).toBe(false)
    expect(hasSingleH1([2, 3])).toBe(false)
    expect(hasSingleH1([])).toBe(false)
  })

  it("hasNoSkippedHeadingLevels: no jump deeper than +1", () => {
    expect(hasNoSkippedHeadingLevels([1, 2, 3, 2])).toBe(true)
    expect(hasNoSkippedHeadingLevels([1, 3])).toBe(false) // skips h2
    expect(hasNoSkippedHeadingLevels([])).toBe(true)
    expect(hasNoSkippedHeadingLevels([2, 2, 1])).toBe(true) // shallower is fine
  })

  it("documentHasLang: non-empty lang", () => {
    expect(documentHasLang("en")).toBe(true)
    expect(documentHasLang("en-US")).toBe(true)
    expect(documentHasLang("")).toBe(false)
    expect(documentHasLang("   ")).toBe(false)
    expect(documentHasLang(null)).toBe(false)
    expect(documentHasLang(undefined)).toBe(false)
  })

  it("meetsTargetSize: 24x24 minimum", () => {
    expect(meetsTargetSize(24, 24)).toBe(true)
    expect(meetsTargetSize(40, 40)).toBe(true)
    expect(meetsTargetSize(20, 44)).toBe(false)
    expect(meetsTargetSize(44, 20)).toBe(false)
  })

  it("fitsViewportWidth: no element wider than the viewport", () => {
    expect(fitsViewportWidth([100, 200, 320], 320)).toBe(true) // <= is fine
    expect(fitsViewportWidth([100, 500], 320)).toBe(false) // one overflows
    expect(fitsViewportWidth([], 320)).toBe(true) // vacuously true
  })
})
