import { describe, expect, it } from "vitest"

import { CONTRAST_CRITERION_IDS, ENHANCED_CRITERION_ID } from "./vpatModel"
import {
  buildVpatReport,
  criterionLabel,
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
    expect(report.wcagVersions).toEqual(["2.0", "2.1", "2.2"])
    expect(report.editions).toEqual(["2.5Rev-wcag"])
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
    const passing = buildVpatReport(FIXED, {
      allPass: true,
      failures: 0,
      allPassEnhanced: true,
      enhancedMisses: 0,
    })
    for (const id of CONTRAST_CRITERION_IDS) {
      const c = passing.criteria.find((x) => x.id === id)
      expect(c?.status, `${id} on passing audit`).toBe("supports")
      expect(c?.evidence).toBe("contrast")
    }
  })

  it("derives 1.4.6 from the AAA tally, independently of the AA verdict", () => {
    // The shipped case: AA clean, AAA short — the AA rows Support while the
    // Enhanced row Partially Supports and names the AAA-miss count.
    const aaOnly = buildVpatReport(FIXED, {
      allPass: true,
      failures: 0,
      allPassEnhanced: false,
      enhancedMisses: 3,
    })
    const enhanced = aaOnly.criteria.find((x) => x.id === ENHANCED_CRITERION_ID)
    expect(enhanced?.status).toBe("partially")
    expect(enhanced?.remark).toContain("3 audited pairs")
    for (const id of CONTRAST_CRITERION_IDS) {
      if (id === ENHANCED_CRITERION_ID) continue
      expect(aaOnly.criteria.find((x) => x.id === id)?.status).toBe("supports")
    }
  })

  it("flips the contrast criteria when the audit fails (proves KTD4 wiring)", () => {
    const failing = buildVpatReport(FIXED, {
      allPass: false,
      failures: 2,
      allPassEnhanced: false,
      enhancedMisses: 2,
    })
    for (const id of CONTRAST_CRITERION_IDS) {
      const c = failing.criteria.find((x) => x.id === id)
      expect(c?.status, `${id} on failing audit`).toBe("partially")
      if (id === ENHANCED_CRITERION_ID) continue
      expect(c?.remark, `${id} names the failing count`).toContain("2 pairs")
    }
    // A non-contrast criterion is unaffected by the audit result: its status is
    // identical whether the contrast audit passes or fails (only the contrast
    // rows are audit-derived). Asserted as an invariant so it survives the
    // manual assessment filling in non-contrast verdicts over time.
    const passing = buildVpatReport(FIXED, {
      allPass: true,
      failures: 0,
      allPassEnhanced: true,
      enhancedMisses: 0,
    })
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

describe("renderVpatReport (WCAG edition)", () => {
  const md = renderVpatReport(FIXED, { version: "1.45.0" })

  it("carries every field the VPAT 2.5Rev essential requirements list", () => {
    expect(md).toContain("# Fifty Foundation Accessibility Conformance Report")
    expect(md).toContain("**WCAG Edition** (Based on VPAT® Version 2.5Rev)")
    expect(md).toContain(
      "**Name of Product/Version:** Classroom50 web app, version 1.45.0",
    )
    expect(md).toContain("**Report Date:** 2026-08-04")
    expect(md).toContain("**Product Description:**")
    expect(md).toContain("**Contact Information:**")
    expect(md).toContain("**Notes:**")
    expect(md).toContain("**Evaluation Methods Used:**")
    expect(md).toContain("## Applicable Standards/Guidelines")
    expect(md).toContain("## Terms")
  })

  it("omits the version clause when the build has none", () => {
    expect(renderVpatReport(FIXED)).toContain(
      "**Name of Product/Version:** Classroom50 web app\n",
    )
  })

  it("lists WCAG 2.0, 2.1, and 2.2 at Level A and AA in the standards table", () => {
    for (const v of ["2.0", "2.1", "2.2"]) {
      expect(md).toContain(
        `| Web Content Accessibility Guidelines ${v} | Level A (Yes), Level AA (Yes), Level AAA (No) |`,
      )
    }
  })

  it("uses the ITI term definitions verbatim", () => {
    expect(md).toContain(
      "**Supports:** The functionality of the product has at least one method that meets the criterion without known defects or meets with equivalent facilitation.",
    )
    expect(md).toContain(
      "**Not Applicable:** The criterion is not relevant to the product.",
    )
  })

  it("declares the Not Evaluated deviation in Notes while A/AA rows await assessment", () => {
    const pending = buildVpatReport(FIXED).criteria.filter(
      (c) => c.level !== "AAA" && c.status === "notEvaluated",
    )
    if (pending.length === 0) {
      expect(md).not.toContain("Deviation from the ITI terms")
      return
    }
    expect(md).toContain(
      `Deviation from the ITI terms: ${pending.length} Level A/AA criteria`,
    )
    for (const c of pending) expect(md).toContain(c.id)
  })

  it("marks criteria newer than WCAG 2.0 the way the template does", () => {
    expect(md).toContain("| 2.1.4 Character Key Shortcuts (2.1 and 2.2) | A |")
    expect(md).toContain("| 2.5.8 Target Size (Minimum) (2.2 only) | AA |")
    expect(md).toContain("| 1.1.1 Non-text Content | A |")
  })

  it("renders Not Applicable rows with their reason instead of omitting them", () => {
    expect(md).toContain(
      "| 1.2.2 Captions (Prerecorded) | A | Not Applicable |",
    )
    expect(md).toContain("| 4.1.1 Parsing | A | Supports |")
  })

  it("has one table per WCAG principle under the WCAG 2.x Report heading", () => {
    expect(md).toContain("## WCAG 2.x Report")
    expect(md).toContain("### Perceivable")
    expect(md).toContain("### Operable")
    expect(md).toContain("### Understandable")
    expect(md).toContain("### Robust")
  })

  it("resolves the contrast criterion 1.4.3 to Supports from its single verdict", () => {
    expect(md).toContain("| 1.4.3 Contrast (Minimum) | AA | Supports |")
  })

  it("renders a row for every criterion in the report", () => {
    const report = buildVpatReport(FIXED)
    for (const c of report.criteria) {
      expect(md, `row for ${c.id}`).toContain(`| ${criterionLabel(c)} |`)
    }
  })

  it("is deterministic for a fixed date", () => {
    expect(renderVpatReport(FIXED, { version: "1.45.0" })).toBe(md)
  })
})

describe("renderVpatJson", () => {
  it("round-trips and matches buildVpatReport's summary", () => {
    const parsed = JSON.parse(renderVpatJson(FIXED))
    expect(parsed.summary).toEqual(buildVpatReport(FIXED).summary)
    expect(parsed.generated).toBe("2026-08-04")
    expect(parsed.vendor).toBe("Fifty Foundation")
    expect(parsed.version).toBeUndefined()
  })

  it("carries the release version when the build supplies one", () => {
    const parsed = JSON.parse(renderVpatJson(FIXED, { version: "1.45.0" }))
    expect(parsed.version).toBe("1.45.0")
  })
})

describe("renderCombinedReport", () => {
  const md = renderCombinedReport(FIXED)

  it("bundles the VPAT and the contrast audit", () => {
    expect(md).toContain("(Based on VPAT® Version 2.5Rev)")
    expect(md).toContain("# WCAG 2.2 Contrast Audit — Classroom50 web app")
  })

  it("does not include the dropped INT / 508 edition", () => {
    expect(md).not.toContain("INT Edition")
    expect(md).not.toContain("Section 508")
  })

  it("separates the two documents with a horizontal rule", () => {
    // One rule joins the two sections; more would signal an extra doc slipped in.
    expect(md.match(/^---$/gm)?.length).toBe(1)
  })

  it("is deterministic for a fixed date", () => {
    expect(renderCombinedReport(FIXED)).toBe(md)
  })
})
