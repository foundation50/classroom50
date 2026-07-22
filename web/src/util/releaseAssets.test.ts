import { describe, expect, it } from "vitest"

import {
  parseReleaseAssets,
  releaseAssetsToText,
  validateReleaseAssets,
} from "./releaseAssets"

describe("release asset textarea conversion", () => {
  it("drops blank lines and one CR while preserving path text and order", () => {
    expect(
      parseReleaseAssets("report.pdf\r\n  \r\n plots/chart.png \r\n"),
    ).toEqual(["report.pdf", " plots/chart.png "])
  })

  it("serializes absent and populated values", () => {
    expect(releaseAssetsToText(undefined)).toBe("")
    expect(releaseAssetsToText(null)).toBe("")
    expect(releaseAssetsToText(["report.pdf", "plots/chart.png"])).toBe(
      "report.pdf\nplots/chart.png",
    )
  })
})

describe("validateReleaseAssets", () => {
  it.each(
    [
      [],
      ["report.pdf", "plots/chart.png", ".github/summary.txt"],
      ["generated*/report.pdf", "plots[2026]/chart.png"],
      ["nested/.git/report.pdf", "résumés 2026/summary.txt"],
      ["😀/report.pdf"],
      ["archive..old/report.pdf"],
      [`${"a".repeat(251)}.pdf`],
    ].map((paths) => [paths]),
  )("accepts %o", (paths) => {
    expect(validateReleaseAssets(paths)).toBeUndefined()
  })

  it("reports the cap", () => {
    expect(
      validateReleaseAssets(Array.from({ length: 50 }, (_, i) => `f${i}.pdf`)),
    ).toBeUndefined()

    const error = validateReleaseAssets(
      Array.from({ length: 51 }, (_, i) => `f${i}.pdf`),
    )
    expect(error).toMatchObject({ kind: "too-many", count: 51, max: 50 })
  })

  it("reports the aggregate UTF-8 path-byte cap", () => {
    const p1 = `${"a".repeat(4094)}/x`
    const exactP2 = `${"é".repeat(2047)}/y`
    expect(validateReleaseAssets([p1, exactP2])).toBeUndefined()

    const overP2 = `${"é".repeat(2047)}z/y`
    expect(validateReleaseAssets([p1, overP2])).toMatchObject({
      kind: "too-large",
      bytes: 8193,
      max: 8192,
    })
  })

  it.each([
    "",
    "  ",
    "/tmp/report.pdf",
    "C:/report.pdf",
    String.raw`plots\\chart.png`,
    "plots//chart.png",
    "./report.pdf",
    "plots/./chart.png",
    "../report.pdf",
    "plots/../report.pdf",
    "plots/",
    "a\nreport.pdf",
    "a\u007freport.pdf",
    "a\u0085report.pdf",
    "\ud800/report.pdf",
    "\udc00/report.pdf",
    ".git/report.pdf",
    ".GiT/report.pdf",
  ])("reports invalid path %o", (path) => {
    expect(validateReleaseAssets([path])?.kind).toBe("invalid-path")
  })

  it.each([
    ".report.pdf",
    "report.pdf.",
    "*.pdf",
    "résumé.pdf",
    `${"a".repeat(252)}.pdf`,
    "result.json",
    "nested/RESULT.JSON",
    "release-body.md",
    "nested/Release-Body.MD",
    "report..pdf",
  ])("reports invalid basename %o", (path) => {
    expect(validateReleaseAssets([path])?.kind).toBe("invalid-basename")
  })

  it("compares duplicate basenames exactly", () => {
    expect(
      validateReleaseAssets(["a/report.pdf", "b/report.pdf"]),
    ).toMatchObject({
      kind: "duplicate-basename",
      basename: "report.pdf",
    })
    expect(
      validateReleaseAssets(["a/report.pdf", "b/Report.pdf"]),
    ).toBeUndefined()
  })

  it("flags an exact duplicate path before the basename check", () => {
    // Mirrors the Go/Python/workflow validators' dual path+basename dedup: an
    // identical repeated path reports duplicate-path (not duplicate-basename).
    expect(
      validateReleaseAssets(["a/report.pdf", "a/report.pdf"]),
    ).toMatchObject({
      kind: "duplicate-path",
      path: "a/report.pdf",
    })
  })
})
