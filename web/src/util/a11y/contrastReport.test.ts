import { describe, expect, it } from "vitest"

import {
  buildContrastAudit,
  renderContrastJson,
  renderContrastReport,
} from "./contrastReport"

describe("renderContrastReport", () => {
  const md = renderContrastReport(new Date("2026-08-04T00:00:00Z"))

  it("states the WCAG 2.2 standard and thresholds", () => {
    expect(md).toContain("WCAG 2.2")
    expect(md).toContain("body text ≥ 7:1")
    expect(md).toContain("large text ≥ 4.5:1")
    expect(md).toContain("non-text ≥ 3:1")
  })

  it("reports all audited pairs meet their floor for the current palette", () => {
    expect(md).toContain("All audited pairs meet their WCAG floor.")
    // No FAIL status appears in a row (the intro/legend may mention FAIL in prose).
    expect(md).not.toMatch(/❌ FAIL \|/)
  })

  it("shows resolved fg/bg hex colors in the table", () => {
    expect(md).toMatch(/text `#[0-9a-f]{6}` on `#[0-9a-f]{6}`/)
  })

  it("includes a table for each theme", () => {
    expect(md).toContain("## Light")
    expect(md).toContain("## Dark")
  })

  it("is deterministic for a fixed date", () => {
    expect(renderContrastReport(new Date("2026-08-04T00:00:00Z"))).toBe(md)
    expect(md).toContain("**Generated:** 2026-08-04")
  })
})

describe("buildContrastAudit (JSON source of truth)", () => {
  const audit = buildContrastAudit(new Date("2026-08-04T00:00:00Z"))

  it("carries the schema, standard, and a summary", () => {
    expect(audit.schema).toBe("contrast-audit/v1")
    expect(audit.standard).toBe("WCAG 2.2")
    expect(audit.summary.total).toBeGreaterThan(0)
    expect(audit.summary.allPass).toBe(audit.summary.failures === 0)
  })

  it("has both themes with rows, valid statuses, and resolved colors", () => {
    const themes = audit.themes.map((t) => t.theme)
    expect(themes).toEqual(["sumi", "sumi-dark"])
    const valid = new Set(["pass", "fail", "exempt"])
    const hex = /^#[0-9a-f]{6}$/
    for (const theme of audit.themes) {
      expect(theme.rows.length).toBeGreaterThan(0)
      for (const r of theme.rows) {
        expect(valid.has(r.status)).toBe(true)
        expect(r.fgHex).toMatch(hex)
        expect(r.bgHex).toMatch(hex)
        // withinMargin only annotates a pass, never a fail/exempt.
        if (r.withinMargin) expect(r.status).toBe("pass")
      }
    }
  })

  it("marks margin-band passes with withinMargin, matching the summary count", () => {
    const flagged = audit.themes.flatMap((t) =>
      t.rows.filter((r) => r.withinMargin),
    )
    expect(flagged.length).toBe(audit.summary.marginMisses)
    for (const r of flagged) {
      expect(r.ratio).toBeGreaterThanOrEqual(r.floor)
      expect(r.ratio).toBeLessThan(r.margin)
    }
  })

  it("reports no failing pairs for the current palette", () => {
    expect(audit.summary.failures).toBe(0)
    const anyFail = audit.themes.some((t) =>
      t.rows.some((r) => r.status === "fail"),
    )
    expect(anyFail).toBe(false)
  })

  it("renders valid, parseable JSON that round-trips the summary", () => {
    const parsed = JSON.parse(
      renderContrastJson(new Date("2026-08-04T00:00:00Z")),
    )
    expect(parsed.summary).toEqual(audit.summary)
    expect(parsed.generated).toBe("2026-08-04")
  })
})
