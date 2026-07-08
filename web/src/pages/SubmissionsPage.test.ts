import { describe, expect, it } from "vitest"

import { cadenceForElapsed } from "./SubmissionsPage"

// The "Updated X ago" label re-renders at a cadence matching the elapsed
// magnitude: every second under a minute, every minute under an hour, every
// hour beyond. Lock the tier boundaries.
describe("cadenceForElapsed", () => {
  it("ticks every second under a minute", () => {
    expect(cadenceForElapsed(0)).toBe(1_000)
    expect(cadenceForElapsed(59_999)).toBe(1_000)
  })

  it("ticks every minute from 1 minute up to an hour", () => {
    expect(cadenceForElapsed(60_000)).toBe(60_000)
    expect(cadenceForElapsed(3_599_999)).toBe(60_000)
  })

  it("ticks every hour at and beyond one hour", () => {
    expect(cadenceForElapsed(3_600_000)).toBe(3_600_000)
    expect(cadenceForElapsed(50_000_000)).toBe(3_600_000)
  })
})
