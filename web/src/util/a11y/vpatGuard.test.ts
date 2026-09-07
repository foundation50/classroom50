import { describe, expect, it } from "vitest"

import { buildContrastAudit } from "./contrastReport"
import { CONTRAST_CRITERION_IDS, ENHANCED_CRITERION_ID } from "./vpatModel"
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
  it("lists every WCAG 2.2 Level A/AA criterion (55), so nothing is silently omitted", () => {
    // 4.1.1 is a 2.0/2.1-only row kept for those reviewers; it is not one of
    // the 55 WCAG 2.2 A/AA criteria.
    const aa = report.criteria.filter(
      (c) => c.level !== "AAA" && c.id !== "4.1.1",
    )
    expect(aa).toHaveLength(55)
    expect(aa.filter((c) => c.level === "A")).toHaveLength(31)
    expect(aa.filter((c) => c.level === "AA")).toHaveLength(24)
  })

  it("declares the WCAG versions the report can be filed against", () => {
    expect(report.wcagVersions).toEqual(["2.0", "2.1", "2.2"])
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

  it.each(report.criteria)(
    "$id never claims Not Applicable without an architectural reason",
    (c) => {
      if (c.status === "notApplicable") {
        expect(c.evidence, `${c.id} N/A with no evidence tag`).toBe(
          "architectural",
        )
        expect(c.remark, `${c.id} N/A with no reason`).toMatch(
          /^Not applicable: /,
        )
      }
    },
  )

  it("derives the contrast criteria from the live contrast audit (not hand-set)", () => {
    const summary = buildContrastAudit().summary
    for (const id of CONTRAST_CRITERION_IDS) {
      // 1.4.6 is the AAA tier: same audit, stricter floors, own verdict.
      const allPass =
        id === ENHANCED_CRITERION_ID ? summary.allPassEnhanced : summary.allPass
      const c = report.criteria.find((x) => x.id === id)
      expect(c, `contrast criterion ${id} present`).toBeDefined()
      expect(c?.evidence).toBe("contrast")
      expect(
        c?.status,
        `${id} must reflect the contrast audit (allPass=${allPass})`,
      ).toBe(allPass ? "supports" : "partially")
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
