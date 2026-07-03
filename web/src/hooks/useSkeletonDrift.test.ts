import { describe, expect, it } from "vitest"

import { resolveSkeletonDrift } from "./useSkeletonDrift"

describe("resolveSkeletonDrift", () => {
  it("shows the banner when a successful check found drifted/missing files", () => {
    expect(
      resolveSkeletonDrift({
        isSuccess: true,
        driftedCount: 2,
        isError: false,
      }),
    ).toBe(true)
  })

  it("stays quiet when a successful check found no drift (clean repo)", () => {
    expect(
      resolveSkeletonDrift({
        isSuccess: true,
        driftedCount: 0,
        isError: false,
      }),
    ).toBe(false)
  })

  it("fails open on a read error — never nag on a failed/forbidden read", () => {
    expect(
      resolveSkeletonDrift({
        isSuccess: false,
        driftedCount: undefined,
        isError: true,
      }),
    ).toBe(false)
  })

  it("fails open when a stale error state still reports a drifted count", () => {
    // A React Query error retaining the previous successful data must not
    // resurrect the banner: isError dominates.
    expect(
      resolveSkeletonDrift({
        isSuccess: false,
        driftedCount: 3,
        isError: true,
      }),
    ).toBe(false)
  })

  it("stays quiet while the check is in flight (no definitive success yet)", () => {
    expect(
      resolveSkeletonDrift({
        isSuccess: false,
        driftedCount: undefined,
        isError: false,
      }),
    ).toBe(false)
  })
})
