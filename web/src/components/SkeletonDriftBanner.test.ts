import { describe, expect, it } from "vitest"

import {
  resolveDriftBannerView,
  type DriftBannerInput,
} from "./SkeletonDriftBanner"

const base: DriftBannerInput = {
  hasOrg: true,
  hasDrift: true,
  fixedThisOrg: false,
  dismissed: false,
  isPending: false,
  isFetching: false,
}

describe("resolveDriftBannerView", () => {
  it("shows the warning when drift exists and nothing was fixed yet", () => {
    expect(resolveDriftBannerView(base)).toBe("warning")
  })

  it("hides everything when there is no org (org picker route)", () => {
    expect(resolveDriftBannerView({ ...base, hasOrg: false })).toBe("hidden")
  })

  it("hides after dismissal even while drift remains", () => {
    expect(resolveDriftBannerView({ ...base, dismissed: true })).toBe("hidden")
  })

  it("stays hidden on a first-load clean org (no fix run, no drift)", () => {
    expect(resolveDriftBannerView({ ...base, hasDrift: false })).toBe("hidden")
  })

  it("shows the success check once a fix cleared the drift", () => {
    expect(
      resolveDriftBannerView({ ...base, fixedThisOrg: true, hasDrift: false }),
    ).toBe("success")
  })

  it("keeps the warning when a fix left drift (declined overwrite)", () => {
    // fixedThisOrg is set, but drift remains — must not flash green.
    expect(
      resolveDriftBannerView({ ...base, fixedThisOrg: true, hasDrift: true }),
    ).toBe("warning")
  })

  it("does not flash success while the post-fix re-check is in flight", () => {
    expect(
      resolveDriftBannerView({
        ...base,
        fixedThisOrg: true,
        hasDrift: false,
        isFetching: true,
      }),
    ).toBe("hidden")
  })

  it("does not flash success while the fix mutation is still pending", () => {
    expect(
      resolveDriftBannerView({
        ...base,
        fixedThisOrg: true,
        hasDrift: false,
        isPending: true,
      }),
    ).toBe("hidden")
  })

  it("suppresses the success check after dismissal wins", () => {
    expect(
      resolveDriftBannerView({
        ...base,
        fixedThisOrg: true,
        hasDrift: false,
        dismissed: true,
      }),
    ).toBe("hidden")
  })
})
