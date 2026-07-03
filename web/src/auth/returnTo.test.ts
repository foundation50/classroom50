import { describe, expect, it } from "vitest"

import { isSafeReturnTo } from "./returnTo"

describe("isSafeReturnTo", () => {
  it("accepts a same-origin relative path", () => {
    expect(isSafeReturnTo("/")).toBe(true)
    expect(isSafeReturnTo("/acme/cs101/assignments/a1/accept")).toBe(true)
    expect(isSafeReturnTo("/acme/cs101/assignments/a1/accept?k=secret")).toBe(
      true,
    )
    // A leading "@" is a same-origin path segment, not a host.
    expect(isSafeReturnTo("/@acme")).toBe(true)
  })

  it("rejects protocol-relative // paths (open-redirect to another host)", () => {
    expect(isSafeReturnTo("//evil.com")).toBe(false)
    expect(isSafeReturnTo("//evil.com/acme")).toBe(false)
  })

  it("rejects absolute URLs and non-leading-slash values", () => {
    expect(isSafeReturnTo("https://evil.com")).toBe(false)
    expect(isSafeReturnTo("http://github.com/x")).toBe(false)
    expect(isSafeReturnTo("evil.com")).toBe(false)
    expect(isSafeReturnTo("acme/cs101")).toBe(false)
  })

  it("rejects backslash protocol-relative payloads (browsers treat \\ as /)", () => {
    expect(isSafeReturnTo("/\\evil.com")).toBe(false)
    expect(isSafeReturnTo("/\\\\evil.com")).toBe(false)
    expect(isSafeReturnTo("/\\/evil.com")).toBe(false)
  })

  it("rejects percent-encoded slashes/backslashes (decoded downstream)", () => {
    expect(isSafeReturnTo("/%2f%2fevil.com")).toBe(false)
    expect(isSafeReturnTo("/%2F%2Fevil.com")).toBe(false)
    expect(isSafeReturnTo("/%5cevil.com")).toBe(false)
  })

  it("rejects leading control / whitespace characters", () => {
    expect(isSafeReturnTo("/\tevil.com")).toBe(false)
    expect(isSafeReturnTo("/\revil.com")).toBe(false)
    expect(isSafeReturnTo("/\nevil.com")).toBe(false)
  })

  it("rejects non-string values", () => {
    expect(isSafeReturnTo(undefined)).toBe(false)
    expect(isSafeReturnTo(null)).toBe(false)
    expect(isSafeReturnTo(42)).toBe(false)
    expect(isSafeReturnTo({})).toBe(false)
  })
})
