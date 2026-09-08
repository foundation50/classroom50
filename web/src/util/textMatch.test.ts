import { describe, expect, it } from "vitest"

import { matchesQuery, normalizeQuery } from "./textMatch"

describe("matchesQuery", () => {
  it("is a trimmed, case-insensitive substring match over any field", () => {
    expect(matchesQuery("  ANN ", "hannah", "x")).toBe(true)
    expect(matchesQuery("ann", "Bob", "Ann Lee")).toBe(true)
    expect(matchesQuery("zed", "Bob", "Ann Lee")).toBe(false)
  })
  it("matches everything on an empty query and skips absent fields", () => {
    expect(matchesQuery("   ")).toBe(true)
    expect(matchesQuery("a", null, undefined, "")).toBe(false)
  })
  it("normalizeQuery is the same rule, exposed for callers that pre-compute", () => {
    expect(normalizeQuery("  Foo ")).toBe("foo")
  })
})
