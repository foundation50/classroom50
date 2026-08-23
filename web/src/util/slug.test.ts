import { describe, expect, it } from "vitest"
import { nextAvailableSlug, slugify } from "./slug"

describe("slugify", () => {
  it("normalizes free text to a repo-safe slug", () => {
    expect(slugify("Loops Assignment")).toBe("loops-assignment")
    expect(slugify("  Hello, World!  ")).toBe("hello-world")
  })

  it("is idempotent on an already-slugified value", () => {
    expect(slugify("loops-assignment")).toBe("loops-assignment")
  })

  it("transliterates Latin-extended diacritics to their base letter", () => {
    // One sample per mark family: acute, grave, circumflex, umlaut/diaeresis,
    // caron, ring, tilde, cedilla, ogonek, breve, macron, dot above.
    expect(slugify("áàâäǎåãçąăāż")).toBe("aaaaaaacaaaz")
    expect(slugify("Introducción à l'Étude")).toBe("introduccion-a-letude")
    expect(slugify("Übung für Anfänger")).toBe("ubung-fur-anfanger")
  })

  it("keeps a diacritic-only word as letters instead of dropping it", () => {
    expect(slugify("čtení")).toBe("cteni")
  })
})

describe("nextAvailableSlug", () => {
  it("returns the base when it is free", () => {
    expect(nextAvailableSlug("hw1", [])).toBe("hw1")
    expect(nextAvailableSlug("hw1", ["hw2"])).toBe("hw1")
  })

  it("suffixes -2, -3 when the base and its suffixes are taken", () => {
    expect(nextAvailableSlug("hw1", ["hw1"])).toBe("hw1-2")
    expect(nextAvailableSlug("hw1", ["hw1", "hw1-2"])).toBe("hw1-3")
  })

  it("continues from a trailing -<n> rather than re-appending", () => {
    expect(nextAvailableSlug("hw1-2", ["hw1-2"])).toBe("hw1-3")
  })

  it("matches case-insensitively (slugs are repo path segments)", () => {
    expect(nextAvailableSlug("hw1", ["HW1"])).toBe("hw1-2")
  })

  it("keeps a suffixed candidate within the 100-char cap", () => {
    const base = "a".repeat(100)
    const result = nextAvailableSlug(base, [base])
    expect(result.length).toBeLessThanOrEqual(100)
    expect(result).toMatch(/-2$/)
  })
})
