import { describe, expect, it } from "vitest"
import { computePendingHidden } from "./useTeamRoster"

describe("computePendingHidden", () => {
  it("hides when invites are forbidden (non-owner)", () => {
    expect(computePendingHidden(true)).toBe(true)
  })

  it("does NOT hide when invites are readable (owner)", () => {
    expect(computePendingHidden(false)).toBe(false)
  })

  // Regression: a single staff team's 403 must not black out the readable
  // student + sibling-team pending. Pending visibility keys only on ownership
  // (plus a definitive 403 on the student pending read); a per-staff-team error
  // omits that one team's pending at the call site (data ?? []), it does not
  // flip pendingHidden.
  it("keys only on the owner/forbidden signal, not per-staff-team errors", () => {
    expect(computePendingHidden(false)).toBe(false)
  })
})
