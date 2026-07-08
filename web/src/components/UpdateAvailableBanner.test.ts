import { describe, expect, it } from "vitest"

import {
  resolveUpdateBannerVisible,
  type UpdateBannerInput,
} from "./UpdateAvailableBanner"

const deployed = "b".repeat(40)

const base: UpdateBannerInput = {
  hasUpdate: true,
  dismissedCommit: undefined,
  deployedCommit: deployed,
}

describe("resolveUpdateBannerVisible", () => {
  it("shows the banner when an update exists and nothing was dismissed", () => {
    expect(resolveUpdateBannerVisible(base)).toBe(true)
  })

  it("hides the banner after the current deployed commit was dismissed", () => {
    expect(
      resolveUpdateBannerVisible({ ...base, dismissedCommit: deployed }),
    ).toBe(false)
  })

  it("re-shows when a newer deploy lands after a dismissal", () => {
    expect(
      resolveUpdateBannerVisible({ ...base, dismissedCommit: "c".repeat(40) }),
    ).toBe(true)
  })

  it("hides the banner when there is no update", () => {
    expect(resolveUpdateBannerVisible({ ...base, hasUpdate: false })).toBe(
      false,
    )
  })

  it("hides the banner when the deployed commit is unknown (defensive)", () => {
    // hasUpdate should already be false without a deployed commit; the guard
    // keeps dismissal comparable even if the inputs ever disagree.
    expect(
      resolveUpdateBannerVisible({ ...base, deployedCommit: undefined }),
    ).toBe(false)
  })
})
