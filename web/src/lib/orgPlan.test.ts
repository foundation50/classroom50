import { describe, expect, it } from "vitest"
import { classifyPlan, planSortWeight } from "./orgPlan"

describe("classifyPlan", () => {
  it("treats team and enterprise as supported", () => {
    expect(classifyPlan("team")).toBe("supported")
    expect(classifyPlan("enterprise")).toBe("supported")
  })

  it("treats free as free", () => {
    expect(classifyPlan("free")).toBe("free")
  })

  it("treats a missing plan name as unknown, never free", () => {
    expect(classifyPlan(undefined)).toBe("unknown")
    expect(classifyPlan("")).toBe("unknown")
  })

  it("treats unrecognized or future plan names as unknown, never free", () => {
    // An unknown value must not be misclassified as free, or we'd hide an org
    // the user can actually work with.
    expect(classifyPlan("business")).toBe("unknown")
    expect(classifyPlan("Team")).toBe("unknown")
  })
})

describe("planSortWeight", () => {
  it("orders supported before unknown before free", () => {
    expect(planSortWeight("supported")).toBeLessThan(planSortWeight("unknown"))
    expect(planSortWeight("unknown")).toBeLessThan(planSortWeight("free"))
  })

  it("keeps unknown above free so an unknown-plan org is never demoted below free", () => {
    expect(planSortWeight("unknown")).toBeLessThan(planSortWeight("free"))
  })
})
