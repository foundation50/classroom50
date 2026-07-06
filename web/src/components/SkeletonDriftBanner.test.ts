import { describe, expect, it } from "vitest"

import {
  isFixResolvedClean,
  resolveDriftBannerView,
  type DriftBannerInput,
} from "./SkeletonDriftBanner"

const base: DriftBannerInput = {
  hasOrg: true,
  hasDrift: true,
  dismissed: false,
  isPending: false,
  fixResolvedClean: false,
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

  it("shows the success check once a fix resolved with no drift left", () => {
    // Driven off the mutation result, so it holds even if the cached drift
    // read hasn't refreshed yet (post-commit tree reads are eventually
    // consistent and may still report the old SHAs).
    expect(
      resolveDriftBannerView({
        ...base,
        fixResolvedClean: true,
        hasDrift: true,
      }),
    ).toBe("success")
  })

  it("keeps the warning when a fix skipped files (declined overwrite)", () => {
    // fixResolvedClean is false because skippedOverwrite was non-empty.
    expect(
      resolveDriftBannerView({
        ...base,
        fixResolvedClean: false,
        hasDrift: true,
      }),
    ).toBe("warning")
  })

  it("does not flash success while the fix mutation is still pending", () => {
    // Pending + drift still present -> stay on the warning view (the button
    // shows its spinner); success must wait until the mutation settles.
    expect(
      resolveDriftBannerView({
        ...base,
        fixResolvedClean: true,
        isPending: true,
      }),
    ).toBe("warning")
  })

  it("suppresses the success check after dismissal wins", () => {
    expect(
      resolveDriftBannerView({
        ...base,
        fixResolvedClean: true,
        dismissed: true,
      }),
    ).toBe("hidden")
  })
})

describe("isFixResolvedClean", () => {
  it("is true when the fix completed and skipped nothing", () => {
    expect(
      isFixResolvedClean({ status: "complete", skippedOverwrite: [] }),
    ).toBe(true)
  })

  it("is false when the fix left files skipped (declined overwrite)", () => {
    expect(
      isFixResolvedClean({
        status: "complete",
        skippedOverwrite: ["workflows/collect-scores.yaml"],
      }),
    ).toBe(false)
  })

  it("is false for any non-complete status", () => {
    expect(isFixResolvedClean({ status: "error", skippedOverwrite: [] })).toBe(
      false,
    )
  })
})
