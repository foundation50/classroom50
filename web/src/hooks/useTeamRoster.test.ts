import { describe, expect, it } from "vitest"
import { computePendingHidden } from "./useTeamRoster"

describe("computePendingHidden", () => {
  it("hides when the org invitations endpoint is forbidden (non-owner)", () => {
    expect(computePendingHidden(true)).toBe(true)
  })

  it("does NOT hide when org invitations are readable (owner)", () => {
    expect(computePendingHidden(false)).toBe(false)
  })

  // Regression: a single staff team's 403 must not black out the readable org +
  // sibling-team pending. Pending visibility keys only on the org-level owner
  // check; a per-team error omits that one team's pending at the call site
  // (data ?? []), it does not flip pendingHidden.
  it("keys only on the org-level owner check, not per-staff-team errors", () => {
    expect(computePendingHidden(false)).toBe(false)
  })
})
