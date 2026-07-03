import { describe, expect, it } from "vitest"

import { isSafeReturnTo } from "./returnTo"

describe("isSafeReturnTo", () => {
  it("accepts a same-origin relative path", () => {
    expect(isSafeReturnTo("/")).toBe(true)
    expect(isSafeReturnTo("/acme/cs101/assignments/a1/accept")).toBe(true)
    expect(isSafeReturnTo("/acme/cs101/assignments/a1/accept?k=secret")).toBe(
      true,
    )
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

  it("rejects non-string values", () => {
    expect(isSafeReturnTo(undefined)).toBe(false)
    expect(isSafeReturnTo(null)).toBe(false)
    expect(isSafeReturnTo(42)).toBe(false)
    expect(isSafeReturnTo({})).toBe(false)
  })
})
