import { describe, expect, it } from "vitest"

import { buildContrastAudit } from "./contrastReport"
import { CONTRAST_CRITERION_IDS } from "./vpatModel"
import { buildVpatReport } from "./vpatReport"

// The VPAT integrity guard. Runs in `npm run check`.
//
// Mirrors the contrast guard's role: it keeps the machine-derived VPAT honest so
// a rendering can never quietly overclaim or drift from the contrast audit it
// folds in. It asserts the invariants — not the specific verdicts — so it stays
// green as the manual assessment fills in criteria, but fails loudly on a
// structural regression (an evidence-free Supports, a hand-set contrast row, an
// emptied criteria set, or an inconsistent summary).

const report = buildVpatReport()

describe("VPAT integrity guard", () => {
  it("has a non-empty criteria set covering both Level A and AA", () => {
    expect(report.criteria.length).toBeGreaterThanOrEqual(25)
    expect(report.criteria.some((c) => c.level === "A")).toBe(true)
    expect(report.criteria.some((c) => c.level === "AA")).toBe(true)
  })

  it.each(report.criteria)(
    "$id never claims Supports without evidence",
    (c) => {
      if (c.status === "supports") {
        expect(
          c.evidence,
          `${c.id} claims Supports with no evidence tag`,
        ).toBeDefined()
      }
    },
  )

  it("derives the contrast criteria from the live contrast audit (not hand-set)", () => {
    const allPass = buildContrastAudit().summary.allPass
    const expected = allPass ? "supports" : "partially"
    for (const id of CONTRAST_CRITERION_IDS) {
      const c = report.criteria.find((x) => x.id === id)
      expect(c, `contrast criterion ${id} present`).toBeDefined()
      expect(c?.evidence).toBe("contrast")
      expect(
        c?.status,
        `${id} must reflect the contrast audit (allPass=${allPass})`,
      ).toBe(expected)
    }
  })

  it("uses contrast evidence on exactly the contrast criteria (no stray tags)", () => {
    const contrastEvidenced = report.criteria
      .filter((c) => c.evidence === "contrast")
      .map((c) => c.id)
      .sort()
    expect(contrastEvidenced).toEqual([...CONTRAST_CRITERION_IDS].sort())
  })

  it("has a summary whose byStatus counts sum to total", () => {
    const s = report.summary.byStatus
    const sum =
      s.supports +
      s.partially +
      s.doesNotSupport +
      s.notApplicable +
      s.notEvaluated
    expect(sum).toBe(report.summary.total)
    expect(report.summary.total).toBe(report.criteria.length)
  })
})
