import { describe, expect, it } from "vitest"

import { ASSESSMENT_GUIDANCE } from "./assessmentGuidance"
import { CRITERIA } from "./vpatModel"

// Every criterion still awaiting a manual verdict must have assessor guidance,
// otherwise the /assess tool shows it with no instructions and it silently
// stays Not Evaluated.
describe("assessmentGuidance", () => {
  const guided = new Set(ASSESSMENT_GUIDANCE.map((g) => g.id))

  it("covers every criterion the manual assessment still owns", () => {
    const outstanding = CRITERIA.filter(
      (c) => c.status === "notEvaluated" && c.evidence === undefined,
    ).map((c) => c.id)
    const missing = outstanding.filter((id) => !guided.has(id))
    expect(missing).toEqual([])
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
