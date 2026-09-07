import { describe, expect, it } from "vitest"

import { orgTeamCreationAllowed } from "./useOrgTeamCreationAllowed"

// The gate must fail OPEN: GitHub omits the member-privilege fields for
// non-admin readers, so only an explicit `false` may block the group type.
describe("orgTeamCreationAllowed", () => {
  it("blocks only on an explicit false", () => {
    expect(orgTeamCreationAllowed({ members_can_create_teams: false })).toBe(
      false,
    )
  })

  it("allows on true", () => {
    expect(orgTeamCreationAllowed({ members_can_create_teams: true })).toBe(
      true,
    )
  })

  it("allows when the field is absent (non-admin reader)", () => {
    expect(orgTeamCreationAllowed({})).toBe(true)
  })

  it("allows when the org details are not loaded", () => {
    expect(orgTeamCreationAllowed(undefined)).toBe(true)
  })
})
