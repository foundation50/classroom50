// Renders the WCAG 2.2 contrast audit as a Markdown report. Pure (no fs, no app
// imports) so it stays a util/ leaf and is unit-testable. The rendered string is
// emitted as a build artifact (never committed): CI uploads it per run, and the
// Vite build writes it to dist/CONTRAST-AUDIT.md (served at /CONTRAST-AUDIT.md).
// This is the human-citable companion to the machine guard
// (contrastGuard.test.ts) — the artifact an accessibility/ADA reviewer or a VPAT
// author reads. Because the guard enforces the same facts, the report is always
// a rendering of guaranteed-green state.

import {
  evaluateAll,
  MARGIN_TARGET,
  SPEC_FLOOR,
  type Theme,
} from "./contrastModel"

const THEME_LABEL: Record<Theme, string> = {
  sumi: "Light (sumi)",
  "sumi-dark": "Dark (sumi-dark)",
}

function statusCell(passesFloor: boolean, passesMargin: boolean): string {
  if (!passesFloor) return "❌ FAIL"
  return passesMargin ? "✅ pass" : "⚠️ margin"
}

/** Build the full audit report as Markdown. Deterministic for a given palette. */
export function renderContrastReport(now = new Date()): string {
  const rows = evaluateAll()
  const failures = rows.filter((r) => !r.exempt && !r.passesFloor)
  const marginMisses = rows.filter(
    (r) => !r.exempt && r.passesFloor && !r.passesMargin,
  )

  const out: string[] = []
  out.push("# WCAG 2.2 Contrast Audit — Classroom50 web app")
  out.push("")
  out.push(
    "Generated from `src/util/contrastModel.ts` (via `npm run audit:contrast`, " +
      "the CI artifact, or the Vite build). Not committed and not hand-edited — " +
      "regenerate it. The machine guard (`src/util/contrastGuard.test.ts`) fails " +
      "CI if any enforced pair drops below its spec floor, so this report always " +
      "reflects guaranteed-green state.",
  )
  out.push("")
  out.push(`- **Generated:** ${now.toISOString().slice(0, 10)}`)
  out.push(
    "- **Standard:** WCAG 2.2 — 1.4.6 Contrast (Enhanced, AAA) for text, " +
      "1.4.11 Non-text Contrast (AA; no AAA tier exists) for UI components.",
  )
  out.push(
    `- **Thresholds:** body text ≥ ${SPEC_FLOOR.body}:1, large text ≥ ${SPEC_FLOOR.large}:1, non-text ≥ ${SPEC_FLOOR.nonText}:1.`,
  )
  out.push(
    `- **Design-safety margin (aspirational, non-blocking):** body ≥ ${MARGIN_TARGET.body}:1, large ≥ ${MARGIN_TARGET.large}:1, non-text ≥ ${MARGIN_TARGET.nonText}:1.`,
  )
  out.push(
    `- **Result:** ${failures.length === 0 ? "**All enforced pairs meet their WCAG floor.**" : `**${failures.length} pair(s) below the WCAG floor.**`}` +
      ` ${marginMisses.length} pair(s) clear the floor but sit inside the safety margin (reported, not enforced).`,
  )
  out.push("")
  out.push(
    "Contrast ratios are computed against the concrete rendered pixel — " +
      "oklab/oklch `color-mix()` and `/NN` opacity are resolved to sRGB and " +
      "flattened over the actual surface, then scored with the WCAG luminance " +
      "formula. The audit unit is a (foreground, surface, size-class) triple, " +
      "since text size and background are per-site facts, not token properties.",
  )
  out.push("")

  for (const theme of ["sumi", "sumi-dark"] as const) {
    out.push(`## ${THEME_LABEL[theme]}`)
    out.push("")
    out.push(
      "| Pair | Foreground / surface | Size | Kind | Ratio | Floor | Status |",
    )
    out.push("| --- | --- | --- | --- | ---: | ---: | --- |")
    for (const r of rows.filter((x) => x.theme === theme)) {
      const status = r.exempt
        ? "— exempt"
        : statusCell(r.passesFloor, r.passesMargin)
      out.push(
        `| \`${r.id.replace(`${theme}:`, "")}\` | ${r.label} | ${r.size} | ${r.kind} | ${r.ratio.toFixed(2)}:1 | ${r.floor}:1 | ${status} |`,
      )
    }
    out.push("")
  }

  out.push("### Legend")
  out.push("")
  out.push("- ✅ pass — meets the WCAG floor and the design-safety margin.")
  out.push(
    "- ⚠️ margin — meets the WCAG floor; below the aspirational margin (not a failure).",
  )
  out.push("- ❌ FAIL — below the WCAG floor (fails CI).")
  out.push(
    "- — exempt — outside WCAG scope (logotypes, disabled/inactive controls, " +
      "structural dividers that are not the sole means of identifying a component).",
  )
  out.push("")

  return out.join("\n") + "\n"
}
