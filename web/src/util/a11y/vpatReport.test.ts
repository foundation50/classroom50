import { describe, expect, it } from "vitest"

import { CONTRAST_CRITERION_IDS } from "./vpatModel"
import {
  buildVpatReport,
  renderCombinedReport,
  renderVpatJson,
  renderVpatReport,
} from "./vpatReport"

const FIXED = new Date("2026-08-04T00:00:00Z")

describe("buildVpatReport (JSON source of truth)", () => {
  const report = buildVpatReport(FIXED)

  it("carries schema, standard, editions, target, product, and date", () => {
    expect(report.schema).toBe("vpat-report/v1")
    expect(report.standard).toBe("WCAG 2.2")
    expect(report.editions).toEqual(["2.5Rev-wcag", "2.5Rev-int"])
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
    const passing = buildVpatReport(FIXED, { allPass: true, failures: 0 })
    for (const id of CONTRAST_CRITERION_IDS) {
      const c = passing.criteria.find((x) => x.id === id)
      expect(c?.status, `${id} on passing audit`).toBe("supports")
      expect(c?.evidence).toBe("contrast")
    }
  })

  it("flips the contrast criteria when the audit fails (proves KTD4 wiring)", () => {
    const failing = buildVpatReport(FIXED, { allPass: false, failures: 2 })
    for (const id of CONTRAST_CRITERION_IDS) {
      const c = failing.criteria.find((x) => x.id === id)
      expect(c?.status, `${id} on failing audit`).toBe("partially")
      expect(c?.remark, `${id} names the failing count`).toContain("2 pairs")
    }
    // A non-contrast criterion is unaffected by the audit result: its status is
    // identical whether the contrast audit passes or fails (only the contrast
    // rows are audit-derived). Asserted as an invariant so it survives the
    // manual assessment filling in non-contrast verdicts over time.
    const passing = buildVpatReport(FIXED, { allPass: true, failures: 0 })
    const nonContrastId = "2.4.6" // not a contrast criterion; audit-independent
    expect(CONTRAST_CRITERION_IDS).not.toContain(nonContrastId)
    const failingStatus = failing.criteria.find(
      (x) => x.id === nonContrastId,
    )?.status
    const passingStatus = passing.criteria.find(
      (x) => x.id === nonContrastId,
    )?.status
    expect(failingStatus).toBe(passingStatus)
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
    expect(md).toContain("VPAT® 2.5Rev — WCAG Edition")
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

describe("renderVpatReport — INT edition", () => {
  const md = renderVpatReport("int", FIXED)

  it("states the INT format and names the three incorporated standards", () => {
    expect(md).toContain(
      "VPAT® 2.5Rev — INT Edition (Section 508 + EN 301 549 + WCAG 2.2)",
    )
    expect(md).toContain("Section 508")
    expect(md).toContain("EN 301 549")
    expect(md).toContain("WCAG 2.2")
  })

  it("notes Section 508 Hardware is Not Applicable for a web app", () => {
    expect(md).toContain("Chapter 4")
    expect(md).toContain("Not Applicable")
  })

  it("shows each criterion with the same conformance word as the WCAG edition (single-source)", () => {
    const wcag = renderVpatReport("wcag", FIXED)
    // 1.4.3 (contrast) resolves to Supports in both editions from one verdict.
    expect(wcag).toContain("| 1.4.3 Contrast (Minimum) | AA | Supports |")
    expect(md).toContain("| 1.4.3 Contrast (Minimum) | AA | Supports |")
  })

  it("renders a row for every criterion in the report", () => {
    const report = buildVpatReport(FIXED)
    for (const c of report.criteria) {
      expect(md, `INT row for ${c.id}`).toContain(`| ${c.id} ${c.name} |`)
    }
  })

  it("is deterministic for a fixed date", () => {
    expect(renderVpatReport("int", FIXED)).toBe(md)
  })
})

describe("renderVpatJson", () => {
  it("round-trips and matches buildVpatReport's summary", () => {
    const parsed = JSON.parse(renderVpatJson(FIXED))
    expect(parsed.summary).toEqual(buildVpatReport(FIXED).summary)
    expect(parsed.generated).toBe("2026-08-04")
  })
})

describe("renderCombinedReport", () => {
  const md = renderCombinedReport(FIXED)

  it("bundles both VPAT editions and the contrast audit", () => {
    expect(md).toContain("VPAT® 2.5Rev — WCAG Edition")
    expect(md).toContain(
      "VPAT® 2.5Rev — INT Edition (Section 508 + EN 301 549 + WCAG 2.2)",
    )
    expect(md).toContain("# WCAG 2.2 Contrast Audit — Classroom50 web app")
  })

  it("separates the three documents with a horizontal rule", () => {
    // Two rules join the three sections; more would signal an extra doc slipped in.
    expect(md.match(/^---$/gm)?.length).toBe(2)
  })

  it("is deterministic for a fixed date", () => {
    expect(renderCombinedReport(FIXED)).toBe(md)
  })
})
