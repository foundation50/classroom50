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

  it("reports all enforced pairs meet their floor for the current palette", () => {
    expect(md).toContain("All enforced pairs meet their WCAG floor.")
    // No table row carries a FAIL status cell (the Legend mentions FAIL in prose).
    expect(md).not.toMatch(/\| ❌ FAIL \|/)
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

  it("has both themes with rows and valid statuses", () => {
    const themes = audit.themes.map((t) => t.theme)
    expect(themes).toEqual(["sumi", "sumi-dark"])
    const valid = new Set(["pass", "margin", "fail", "exempt"])
    for (const theme of audit.themes) {
      expect(theme.rows.length).toBeGreaterThan(0)
      for (const r of theme.rows) expect(valid.has(r.status)).toBe(true)
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
