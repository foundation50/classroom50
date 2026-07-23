import { describe, expect, it } from "vitest"
import { isSafeHttpUrl, normalizeWebsiteUrl, safeHttpUrl } from "./url"

describe("isSafeHttpUrl", () => {
  it("accepts http and https absolute URLs", () => {
    expect(isSafeHttpUrl("https://github.com/acme/repo/commit/abc")).toBe(true)
    expect(isSafeHttpUrl("http://example.com")).toBe(true)
  })

  it("rejects script-injection schemes", () => {
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false)
    expect(isSafeHttpUrl("data:text/html,<script>alert(1)</script>")).toBe(
      false,
    )
    expect(isSafeHttpUrl("vbscript:msgbox(1)")).toBe(false)
  })

  it("rejects empty, null, and malformed values", () => {
    expect(isSafeHttpUrl("")).toBe(false)
    expect(isSafeHttpUrl(null)).toBe(false)
    expect(isSafeHttpUrl(undefined)).toBe(false)
    expect(isSafeHttpUrl("not a url")).toBe(false)
    expect(isSafeHttpUrl("/relative/path")).toBe(false)
  })
})

describe("safeHttpUrl", () => {
  it("returns the URL when safe, undefined otherwise", () => {
    expect(safeHttpUrl("https://github.com")).toBe("https://github.com")
    expect(safeHttpUrl("javascript:alert(1)")).toBeUndefined()
    expect(safeHttpUrl(undefined)).toBeUndefined()
  })
})

describe("normalizeWebsiteUrl", () => {
  it("defaults a bare host to https://", () => {
    expect(normalizeWebsiteUrl("classroom50.org")).toBe(
      "https://classroom50.org",
    )
    expect(normalizeWebsiteUrl("www.example.com/path")).toBe(
      "https://www.example.com/path",
    )
  })

  it("preserves an explicit http(s) scheme", () => {
    expect(normalizeWebsiteUrl("http://example.com")).toBe("http://example.com")
    expect(normalizeWebsiteUrl("https://example.com/x")).toBe(
      "https://example.com/x",
    )
  })

  it("trims surrounding whitespace", () => {
    expect(normalizeWebsiteUrl("  example.com  ")).toBe("https://example.com")
  })

  it("returns empty string for blank input (clears the field)", () => {
    expect(normalizeWebsiteUrl("")).toBe("")
    expect(normalizeWebsiteUrl("   ")).toBe("")
    expect(normalizeWebsiteUrl(undefined)).toBe("")
  })

  it("rejects a script-injection scheme (undefined)", () => {
    expect(normalizeWebsiteUrl("javascript:alert(1)")).toBeUndefined()
  })
})
