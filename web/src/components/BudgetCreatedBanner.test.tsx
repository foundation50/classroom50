import { describe, expect, it } from "vitest"

import { resolveBudgetBannerView } from "./BudgetCreatedBanner"

describe("resolveBudgetBannerView", () => {
  it("hidden with no org", () => {
    expect(
      resolveBudgetBannerView({
        hasOrg: false,
        created: true,
        dismissed: false,
      }),
    ).toBe("hidden")
  })

  it("hidden when not created", () => {
    expect(
      resolveBudgetBannerView({
        hasOrg: true,
        created: false,
        dismissed: false,
      }),
    ).toBe("hidden")
  })

  it("hidden when dismissed", () => {
    expect(
      resolveBudgetBannerView({ hasOrg: true, created: true, dismissed: true }),
    ).toBe("hidden")
  })

  it("success when created and not dismissed", () => {
    expect(
      resolveBudgetBannerView({
        hasOrg: true,
        created: true,
        dismissed: false,
      }),
    ).toBe("success")
  })
})
