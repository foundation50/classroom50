import { describe, expect, it } from "vitest"

import {
  assessAltText,
  isLikelyMeaningfulAlt,
  type AltTextIssue,
} from "./altTextHeuristic"

const issues = (alt: string, adjacent?: string): AltTextIssue[] =>
  assessAltText(alt, adjacent).map((f) => f.issue)

describe("assessAltText", () => {
  it("flags a raw filename", () => {
    expect(issues("IMG_1234.png")).toContain("filename")
    expect(issues("hero-banner.jpg")).toContain("filename")
    expect(issues("diagram.svg")).toContain("filename")
  })

  it("flags a filename embedded mid-string", () => {
    expect(issues("see banner.png here")).toContain("filename")
  })

  it("flags generic placeholder values", () => {
    expect(issues("image")).toContain("placeholder")
    expect(issues("Logo")).toContain("placeholder")
    expect(issues("  screenshot ")).toContain("placeholder")
  })

  it("flags a redundant 'image of' phrase", () => {
    expect(issues("Image of a golden retriever")).toContain("redundantWord")
    expect(issues("photo of the campus")).toContain("redundantWord")
  })

  it("flags alt that only duplicates adjacent visible text", () => {
    expect(issues("Open settings", "Open settings")).toContain(
      "duplicateOfAdjacentText",
    )
    // Different adjacent text is fine.
    expect(issues("Course logo for CS50", "CS50")).not.toContain(
      "duplicateOfAdjacentText",
    )
  })

  it("treats empty alt as out of scope (axe's image-alt owns that)", () => {
    expect(assessAltText("")).toEqual([])
    expect(assessAltText("   ")).toEqual([])
  })

  it("passes a genuine description", () => {
    expect(
      assessAltText("A student submitting an assignment via the CLI"),
    ).toEqual([])
    expect(isLikelyMeaningfulAlt("Bar chart of weekly submissions")).toBe(true)
  })

  it("can report multiple issues at once", () => {
    // A filename that is also the adjacent text.
    const found = issues("banner.png", "banner.png")
    expect(found).toContain("filename")
    expect(found).toContain("duplicateOfAdjacentText")
  })
})
