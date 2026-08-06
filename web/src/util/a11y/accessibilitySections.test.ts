import { describe, expect, it } from "vitest"

import { sectionFromHash } from "./accessibilitySections"

// sectionFromHash is the single source of truth for the active section: it
// drives both the page's rendered panel and the drawer's active-pill highlight,
// so a regression here misroutes every deep link. Pin the three behaviors.
describe("sectionFromHash", () => {
  it("falls back to the default section for an empty or missing hash", () => {
    expect(sectionFromHash(undefined)).toBe("conformance")
    expect(sectionFromHash("")).toBe("conformance")
    expect(sectionFromHash("#")).toBe("conformance")
  })

  it("resolves a valid section with or without the leading '#'", () => {
    expect(sectionFromHash("#color-contrast")).toBe("color-contrast")
    expect(sectionFromHash("color-contrast")).toBe("color-contrast")
    expect(sectionFromHash("#statement")).toBe("statement")
    expect(sectionFromHash("downloads")).toBe("downloads")
  })

  it("falls back to the default for an unknown hash", () => {
    expect(sectionFromHash("#bogus")).toBe("conformance")
    expect(sectionFromHash("#downloads/../conformance")).toBe("conformance")
  })
})
