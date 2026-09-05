import { describe, expect, it } from "vitest"

import { ASSESSMENT_GUIDANCE } from "./assessmentGuidance"
import verdicts from "../../../accessibility/vpatVerdicts.json" with { type: "json" }
import { CRITERIA, isManuallyOwned, type VerdictOverlay } from "./vpatModel"

// Every criterion the manual assessment owns (awaiting a verdict or already
// carrying one) must have assessor guidance, otherwise the /assess tool shows
// it with no instructions and a re-assessment has nothing to follow.
describe("assessmentGuidance", () => {
  const guided = new Set(ASSESSMENT_GUIDANCE.map((g) => g.id))
  const overlay = verdicts as VerdictOverlay

  it("covers every manually-owned criterion", () => {
    const owned = CRITERIA.filter((c) => isManuallyOwned(c, overlay)).map(
      (c) => c.id,
    )
    expect(owned.length).toBeGreaterThan(0)
    expect(owned.filter((id) => !guided.has(id))).toEqual([])
  })

  it("only targets criteria that exist in the model", () => {
    const known = new Set(CRITERIA.map((c) => c.id))
    expect([...guided].filter((id) => !known.has(id))).toEqual([])
  })

  it("has a lead-in bullet and no duplicate ids", () => {
    expect(guided.size).toBe(ASSESSMENT_GUIDANCE.length)
    for (const g of ASSESSMENT_GUIDANCE) {
      expect(g.bullets.length, g.id).toBeGreaterThanOrEqual(2)
      expect(g.bullets[0].label, g.id).toBe("Supports means")
    }
  })
})
