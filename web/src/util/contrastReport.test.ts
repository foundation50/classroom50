import { describe, expect, it } from "vitest"

import { renderContrastReport } from "./contrastReport"

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
    expect(md).toContain("## Light (sumi)")
    expect(md).toContain("## Dark (sumi-dark)")
  })

  it("is deterministic for a fixed date", () => {
    expect(renderContrastReport(new Date("2026-08-04T00:00:00Z"))).toBe(md)
    expect(md).toContain("**Generated:** 2026-08-04")
  })
})
