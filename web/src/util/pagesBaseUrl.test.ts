import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  isValidPagesBaseUrl,
  normalizePagesBaseUrl,
  PAGES_BASE_URL_PATTERN,
} from "./pagesBaseUrl"

describe("isValidPagesBaseUrl", () => {
  it("accepts a normalized org-root custom-domain base", () => {
    expect(isValidPagesBaseUrl("https://cs.example.edu/classroom50")).toBe(true)
  })

  it("accepts a repo-CNAME base with no path", () => {
    expect(isValidPagesBaseUrl("https://pages.example.edu")).toBe(true)
  })

  it("rejects empty, http, trailing slash, query/fragment, userinfo, whitespace", () => {
    expect(isValidPagesBaseUrl("")).toBe(false)
    expect(isValidPagesBaseUrl("http://cs.example.edu/classroom50")).toBe(false)
    expect(isValidPagesBaseUrl("https://cs.example.edu/classroom50/")).toBe(
      false,
    )
    expect(isValidPagesBaseUrl("https://cs.example.edu/x?y=1")).toBe(false)
    expect(isValidPagesBaseUrl("https://cs.example.edu/x#frag")).toBe(false)
    expect(isValidPagesBaseUrl("https://user:pw@cs.example.edu/x")).toBe(false)
    expect(isValidPagesBaseUrl("https://cs.example.edu/a b")).toBe(false)
  })

  it("rejects an over-long URL (pattern bound)", () => {
    const long = `https://cs.example.edu/${"a".repeat(120)}`
    expect(isValidPagesBaseUrl(long)).toBe(false)
  })
})

describe("normalizePagesBaseUrl", () => {
  it("returns '' for empty/whitespace input (clear the setting)", () => {
    expect(normalizePagesBaseUrl("")).toBe("")
    expect(normalizePagesBaseUrl("   ")).toBe("")
  })

  it("expands a bare domain to the org-root custom-domain layout", () => {
    expect(normalizePagesBaseUrl("cs.example.edu")).toBe(
      "https://cs.example.edu/classroom50",
    )
    expect(normalizePagesBaseUrl("  CS.Example.EDU  ")).toBe(
      "https://cs.example.edu/classroom50",
    )
  })

  it("takes a full https URL verbatim minus the trailing slash", () => {
    expect(normalizePagesBaseUrl("https://pages.example.edu")).toBe(
      "https://pages.example.edu",
    )
    expect(normalizePagesBaseUrl("https://cs.example.edu/classroom50/")).toBe(
      "https://cs.example.edu/classroom50",
    )
  })

  it("rejects a dotless host, http, and malformed URLs", () => {
    expect(normalizePagesBaseUrl("localhost")).toBeNull()
    expect(normalizePagesBaseUrl("http://cs.example.edu")).toBeNull()
    expect(normalizePagesBaseUrl("https://cs.example.edu/x?y=1")).toBeNull()
    expect(normalizePagesBaseUrl("not a url")).toBeNull()
  })

  it("always yields a value isValidPagesBaseUrl accepts (or ''/null)", () => {
    for (const input of [
      "cs.example.edu",
      "https://pages.example.edu/",
      "https://cs.example.edu/classroom50",
    ]) {
      const out = normalizePagesBaseUrl(input)
      expect(out).not.toBeNull()
      expect(isValidPagesBaseUrl(out!)).toBe(true)
    }
  })
})

describe("PAGES_BASE_URL_PATTERN parity", () => {
  // Byte-mirror of contract.PagesBaseURLPattern (cli/shared) and the schema
  // pattern in classroom-v1 / classroom-team-v1 — a cross-language contract
  // with no compile-time link. Pin against both schema files so a one-sided
  // edit fails here.
  it("matches the schema patterns", () => {
    const tsPattern = PAGES_BASE_URL_PATTERN.source.replace(/\\\//g, "/")
    for (const schemaFile of [
      "../../../schemas/classroom-v1.schema.json",
      "../../../schemas/classroom-team-v1.schema.json",
    ]) {
      const schema = JSON.parse(
        readFileSync(
          fileURLToPath(new URL(schemaFile, import.meta.url)),
          "utf8",
        ),
      ) as { properties: { pages_base_url: { pattern: string } } }
      expect(schema.properties.pages_base_url.pattern).toBe(tsPattern)
    }
  })
})
