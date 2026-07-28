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

  it("rejects a whole CSV row (commas / multiple fields) as a single email", () => {
    // A mis-detected roster row must NOT parse as one valid email — the old
    // regex allowed commas, so `[^\s@]+@[^\s@]+\.[^\s@]+` matched these.
    expect(
      isValidEmail("colton-fifty,,,test@gmail.com,,283008669,teacher"),
    ).toBe(false)
    expect(isValidEmail("username,first_name,last_name,email")).toBe(false)
    expect(isValidEmail("a@b.com,c@d.com")).toBe(false)
    expect(isValidEmail("name <a@b.com>")).toBe(false)
  })
})
