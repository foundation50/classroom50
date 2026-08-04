import { describe, expect, it } from "vitest"

import { CONTRAST_CRITERION_IDS } from "./vpatModel"
import { buildVpatReport, renderVpatJson, renderVpatReport } from "./vpatReport"

const FIXED = new Date("2026-08-04T00:00:00Z")

describe("buildVpatReport (JSON source of truth)", () => {
  const report = buildVpatReport(FIXED)

  it("carries schema, standard, editions, target, product, and date", () => {
    expect(report.schema).toBe("vpat-report/v1")
    expect(report.standard).toBe("WCAG 2.2")
    expect(report.editions).toEqual(["2.5-wcag", "2.5-508"])
    expect(report.target).toBe("AA")
    expect(report.product.length).toBeGreaterThan(0)
    expect(report.generated).toBe("2026-08-04")
  })

  it("has a byStatus breakdown that sums to total", () => {
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

  it("derives the contrast criteria from the audit — passing → Supports", () => {
    const passing = buildVpatReport(FIXED, true)
    for (const id of CONTRAST_CRITERION_IDS) {
      const c = passing.criteria.find((x) => x.id === id)
      expect(c?.status, `${id} on passing audit`).toBe("supports")
      expect(c?.evidence).toBe("contrast")
    }
  })

  it("flips the contrast criteria when the audit fails (proves KTD4 wiring)", () => {
    const failing = buildVpatReport(FIXED, false)
    for (const id of CONTRAST_CRITERION_IDS) {
      const c = failing.criteria.find((x) => x.id === id)
      expect(c?.status, `${id} on failing audit`).toBe("partially")
    }
    // A non-contrast criterion is unaffected by the audit result.
    const nonContrast = failing.criteria.find((x) => x.id === "2.1.1")
    expect(nonContrast?.status).toBe("notEvaluated")
  })

  it("never claims supports without evidence", () => {
    for (const c of report.criteria) {
      if (c.status === "supports") expect(c.evidence).toBeDefined()
    }
  })
})

describe("renderVpatReport — WCAG edition", () => {
  const md = renderVpatReport("wcag", FIXED)

  it("states the format, standard, and date", () => {
    expect(md).toContain("VPAT® 2.5 — WCAG Edition")
    expect(md).toContain("WCAG 2.2, target Level AA")
    expect(md).toContain("Report date:** 2026-08-04")
  })

  it("has one table per WCAG principle", () => {
    expect(md).toContain("## Perceivable")
    expect(md).toContain("## Operable")
    expect(md).toContain("## Understandable")
    expect(md).toContain("## Robust")
  })

  it("renders a row for every criterion in the report", () => {
    const report = buildVpatReport(FIXED)
    for (const c of report.criteria) {
      expect(md, `row for ${c.id}`).toContain(`| ${c.id} ${c.name} |`)
    }
  })

  it("is deterministic for a fixed date", () => {
    expect(renderVpatReport("wcag", FIXED)).toBe(md)
  })
})

describe("renderVpatReport — Section 508 edition", () => {
  const md = renderVpatReport("508", FIXED)

  it("states the 508 format and shows the four chapter headings", () => {
    expect(md).toContain("VPAT® 2.5 — Section 508 Edition")
    expect(md).toContain("Chapter 3: Functional Performance Criteria")
    expect(md).toContain("Chapter 4: Hardware")
    expect(md).toContain("Chapter 5: Software")
    expect(md).toContain("Chapter 6: Support Documentation and Services")
  })

  it("marks the Hardware chapter Not Applicable (no web analog)", () => {
    const hardwareIdx = md.indexOf("Chapter 4: Hardware")
    const softwareIdx = md.indexOf("Chapter 5: Software")
    const between = md.slice(hardwareIdx, softwareIdx)
    expect(between).toContain("Not Applicable")
  })

  it("shows each mapped 508 row with the same conformance word as WCAG (single-source)", () => {
    const wcag = renderVpatReport("wcag", FIXED)
    // 1.4.3 (contrast) resolves to Supports in both editions from one verdict.
    expect(wcag).toContain("| 1.4.3 Contrast (Minimum) | AA | Supports |")
    expect(md).toContain("| 1.4.3 Contrast (Minimum) | AA | Supports |")
  })

  it("is deterministic for a fixed date", () => {
    expect(renderVpatReport("508", FIXED)).toBe(md)
  })
})

describe("renderVpatJson", () => {
  it("round-trips and matches buildVpatReport's summary", () => {
    const parsed = JSON.parse(renderVpatJson(FIXED))
    expect(parsed.summary).toEqual(buildVpatReport(FIXED).summary)
    expect(parsed.generated).toBe("2026-08-04")
  })
})
