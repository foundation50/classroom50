import { describe, expect, it } from "vitest"
import { isValidEmail, normalizeEmail } from "./orgMembership"

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Foo@Example.COM ")).toBe("foo@example.com")
  })

  it("does NOT strip +tags or dots (distinct addresses stay distinct)", () => {
    expect(normalizeEmail("a+tag@gmail.com")).toBe("a+tag@gmail.com")
    expect(normalizeEmail("a.b@gmail.com")).toBe("a.b@gmail.com")
  })
})

describe("isValidEmail", () => {
  it("accepts a typical address", () => {
    expect(isValidEmail("student@university.edu")).toBe(true)
    expect(isValidEmail("  a+tag@gmail.com  ")).toBe(true)
  })

  it("rejects obvious non-emails", () => {
    expect(isValidEmail("")).toBe(false)
    expect(isValidEmail("nope")).toBe(false)
    expect(isValidEmail("a@b")).toBe(false)
    expect(isValidEmail("a @b.com")).toBe(false)
  })
})
