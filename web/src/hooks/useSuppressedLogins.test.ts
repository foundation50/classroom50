import { describe, expect, it } from "vitest"

import { dropSuppressed } from "./useSuppressedLogins"

// Set-backed stub matching the { has } shape the effects pass (a real
// SuppressedLogins stores normalized logins, so the stub does too).
const suppressing = (...logins: string[]) => {
  const set = new Set(logins.map((l) => l.trim().toLowerCase()))
  return { has: (login: string) => set.has(login) }
}

describe("dropSuppressed", () => {
  it("keeps candidates that are not suppressed", () => {
    expect(dropSuppressed(["alice", "bob"], suppressing("carol"))).toEqual([
      "alice",
      "bob",
    ])
  })

  it("drops suppressed candidates", () => {
    expect(dropSuppressed(["alice", "bob"], suppressing("alice"))).toEqual([
      "bob",
    ])
  })

  it("normalizes case and whitespace on the candidate side", () => {
    // The just-unenrolled login was stored lowercased; a candidate arriving as
    // "ALICE" or " alice " must still be recognized as suppressed.
    expect(dropSuppressed(["ALICE", " bob "], suppressing("alice"))).toEqual([
      " bob ",
    ])
  })

  it("returns everything when nothing is suppressed", () => {
    expect(dropSuppressed(["alice", "bob"], suppressing())).toEqual([
      "alice",
      "bob",
    ])
  })

  it("returns an empty list when every candidate is suppressed", () => {
    expect(
      dropSuppressed(["alice", "bob"], suppressing("alice", "bob")),
    ).toEqual([])
  })
})
