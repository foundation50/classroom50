import { describe, expect, it } from "vitest"
import { orgFooterRoleLabel } from "./footerRoleLabel"

const base = {
  hasOrg: true,
  isOrgSetup: false,
  isOwner: false,
  ownerPending: false,
  ownerError: false,
  isStudent: false,
  roleLoading: false,
}

describe("orgFooterRoleLabel", () => {
  it("confirmed org owner => Instructor, not pending", () => {
    expect(orgFooterRoleLabel({ ...base, isOwner: true })).toEqual({
      labelKey: "nav.roleInstructor",
      pending: false,
    })
  })

  it("org setup route => Instructor even without an owner verdict yet", () => {
    expect(orgFooterRoleLabel({ ...base, isOrgSetup: true })).toEqual({
      labelKey: "nav.roleInstructor",
      pending: false,
    })
  })

  it("definitive non-owner student => Student", () => {
    expect(orgFooterRoleLabel({ ...base, isStudent: true })).toEqual({
      labelKey: "nav.roleStudent",
      pending: false,
    })
  })

  it("non-owner, non-student org member => blank", () => {
    expect(orgFooterRoleLabel(base)).toEqual({
      labelKey: null,
      pending: false,
    })
  })

  it("owner-pending with an org in scope => pending spinner, no premature label", () => {
    expect(
      orgFooterRoleLabel({ ...base, ownerPending: true, isStudent: true }),
    ).toEqual({
      // isStudent must NOT win while owner is still pending (would flash Student
      // at a real owner mid-load).
      labelKey: null,
      pending: true,
    })
  })

  it("owner-pending with NO org in scope (/orgs list) => never a permanent spinner", () => {
    expect(
      orgFooterRoleLabel({ ...base, hasOrg: false, ownerPending: true }),
    ).toEqual({
      labelKey: null,
      pending: false,
    })
  })

  it("settled owner-error + config 404 => blank, not Student (don't mislabel a real owner)", () => {
    expect(
      orgFooterRoleLabel({ ...base, ownerError: true, isStudent: true }),
    ).toEqual({
      // A settled owner-error means the verdict is untrustworthy; suppress the
      // Student fallback. Not pending (error is settled), so no spinner.
      labelKey: null,
      pending: false,
    })
  })

  it("config-repo role loading => pending, Student suppressed until it resolves", () => {
    expect(
      orgFooterRoleLabel({ ...base, roleLoading: true, isStudent: true }),
    ).toEqual({
      labelKey: null,
      pending: true,
    })
  })
})
