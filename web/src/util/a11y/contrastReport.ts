// The WCAG 2.2 contrast audit, in two renderings that share one source of truth.
//
// `buildContrastAudit()` produces the structured JSON — the canonical artifact.
// The web page (/accessibility) renders it into native tables, the Markdown
// report is derived from it for download/sharing, and CI/the Vite build emit
// the JSON so both consumers stay in sync. Pure (no fs, no app imports) so it
// stays a util/ leaf and is unit-testable. Because the contrast guard tests
// enforce the same facts, every rendering reflects guaranteed-green state.

import {
  ENHANCED_FLOOR,
  evaluateAll,
  MARGIN_TARGET,
  SPEC_FLOOR,
  type SizeClass,
  type Theme,
} from "./contrastModel.ts"

export type ContrastStatus = "pass" | "fail" | "exempt"

export type ContrastAuditRow = {
  id: string
  label: string
  size: SizeClass
  kind: "text" | "nonText"
  ratio: number
  floor: number
  margin: number
  status: ContrastStatus
  /** Clears the WCAG floor (a Pass) but sits below the recommended margin. */
  withinMargin: boolean
  /** Also clears the AAA 1.4.6 floor (reported only; never enforced). */
  meetsEnhanced: boolean
  /** Displayed foreground (fg composited over the opaque surface), sRGB hex. */
  fgHex: string
  /** Opaque surface behind the text, sRGB hex. */
  bgHex: string
}

export type ContrastAuditTheme = {
  theme: Theme
  label: string
  rows: ContrastAuditRow[]
}

export type ContrastAuditJson = {
  /** Bump when the JSON shape changes so consumers can guard. */
  schema: "contrast-audit/v1"
  standard: "WCAG 2.2"
  generated: string
  thresholds: typeof SPEC_FLOOR
  margins: typeof MARGIN_TARGET
  /** The AAA 1.4.6 text floors the audit also scores against (never enforced). */
  enhancedThresholds: typeof ENHANCED_FLOOR
  summary: {
    total: number
    failures: number
    marginMisses: number
    allPass: boolean
    /** Pairs that clear their AA floor but not the AAA 1.4.6 one. */
    enhancedMisses: number
    /** True when every enforced pair also clears AAA — what 1.4.6 derives from. */
    allPassEnhanced: boolean
  }
  themes: ContrastAuditTheme[]
}

const THEME_LABEL: Record<Theme, string> = {
  sumi: "Light",
  "sumi-dark": "Dark",
}

function statusOf(
  exempt: boolean | undefined,
  passesFloor: boolean,
): ContrastStatus {
  if (exempt) return "exempt"
  return passesFloor ? "pass" : "fail"
}

/** The canonical structured audit. Deterministic for a given palette + date. */
export function buildContrastAudit(now = new Date()): ContrastAuditJson {
  const rows = evaluateAll()
  const failures = rows.filter((r) => !r.exempt && !r.passesFloor).length
  const marginMisses = rows.filter(
    (r) => !r.exempt && r.passesFloor && !r.passesMargin,
  ).length
  const enhancedMisses = rows.filter(
    (r) => !r.exempt && r.passesFloor && !r.passesEnhanced,
  ).length

  const themes: ContrastAuditTheme[] = (["sumi", "sumi-dark"] as const).map(
    (theme) => ({
      theme,
      label: THEME_LABEL[theme],
      rows: rows
        .filter((r) => r.theme === theme)
        .map((r) => ({
          id: r.id.replace(`${theme}:`, ""),
          label: r.label,
          size: r.size,
          kind: r.kind,
          ratio: Number(r.ratio.toFixed(2)),
          floor: r.floor,
          margin: r.margin,
          status: statusOf(r.exempt, r.passesFloor),
          withinMargin: !r.exempt && r.passesFloor && !r.passesMargin,
          meetsEnhanced: r.passesEnhanced,
          fgHex: r.fgHex,
          bgHex: r.bgHex,
        })),
    }),
  )

  return {
    schema: "contrast-audit/v1",
    standard: "WCAG 2.2",
    generated: now.toISOString().slice(0, 10),
    thresholds: SPEC_FLOOR,
    margins: MARGIN_TARGET,
    enhancedThresholds: ENHANCED_FLOOR,
    summary: {
      total: rows.length,
      failures,
      marginMisses,
      allPass: failures === 0,
      enhancedMisses,
      allPassEnhanced: failures === 0 && enhancedMisses === 0,
    },
    themes,
  }
}

/** Serialize the canonical audit as pretty JSON (the emitted artifact). */
export function renderContrastJson(now = new Date()): string {
  return JSON.stringify(buildContrastAudit(now), null, 2) + "\n"
}

// Markdown status cell. A pair that clears the WCAG floor is a pass; the
// `withinMargin` flag adds a note that it sits below the recommended target.
function statusCell(row: ContrastAuditRow): string {
  if (row.status === "exempt") return "— exempt"
  if (row.status === "fail") return "❌ FAIL"
  return row.withinMargin
    ? `✅ pass (below ${row.margin}:1 recommended)`
    : "✅ pass"
}

/** Render the Markdown report — derived from the same structured audit. */
export function renderContrastReport(now = new Date()): string {
  const audit = buildContrastAudit(now)
  const { thresholds: t, margins: m, enhancedThresholds: e, summary } = audit

  const out: string[] = []
  out.push("# WCAG 2.2 Contrast Audit — Classroom 50 web app")
  out.push("")
  out.push(
    "Derived from `contrast-audit.json` (built from `src/util/a11y/contrastModel.ts`). " +
      "Not committed and not hand-edited — regenerate it. The machine guard " +
      "(`src/util/a11y/contrastGuard.test.ts`) fails CI if any enforced pair drops " +
      "below its spec floor, so this report always reflects guaranteed-green state.",
  )
  out.push("")
  out.push(`- **Generated:** ${audit.generated}`)
  out.push(
    "- **Standard:** WCAG 2.2 — 1.4.3 Contrast (Minimum, AA) for text, " +
      "1.4.11 Non-text Contrast (AA) for UI components. The palette is GitHub " +
      "Primer verbatim, and Primer's primitives are tuned to AA, so AA is the " +
      "enforced target; 1.4.6 (Enhanced, AAA) is scored below but not required.",
  )
  out.push(
    `- **Thresholds:** body text ≥ ${t.body}:1, large text ≥ ${t.large}:1, non-text ≥ ${t.nonText}:1.`,
  )
  out.push(
    `- **Recommended safety margin (above the WCAG minimum):** body ≥ ${m.body}:1, large ≥ ${m.large}:1, non-text ≥ ${m.nonText}:1. Extra headroom for anti-aliasing, sub-pixel rendering, and future palette tweaks; not required for conformance.`,
  )
  out.push(
    `- **Enhanced (1.4.6 AAA, reported only):** body ≥ ${e.body}:1, large ≥ ${e.large}:1.` +
      ` ${summary.enhancedMisses === 0 ? "**Every audited pair also clears AAA.**" : `${summary.enhancedMisses} pair(s) meet AA but not AAA.`}`,
  )
  out.push(
    `- **Result:** ${summary.allPass ? "**All audited pairs meet their WCAG floor.**" : `**${summary.failures} pair(s) below the WCAG floor.**`}` +
      ` ${summary.marginMisses} pass but sit below the recommended margin.`,
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

  for (const theme of audit.themes) {
    out.push(`## ${theme.label}`)
    out.push("")
    out.push(
      "| Pair | Foreground / surface | Colors | Size | Ratio | Floor | Status | AAA |",
    )
    out.push("| --- | --- | --- | --- | ---: | ---: | --- | --- |")
    for (const r of theme.rows) {
      const colors = `text \`${r.fgHex}\` on \`${r.bgHex}\``
      const enhanced =
        r.status === "exempt" ? "—" : r.meetsEnhanced ? "✅" : "—"
      out.push(
        `| \`${r.id}\` | ${r.label} | ${colors} | ${r.size} | ${r.ratio.toFixed(2)}:1 | ${r.floor}:1 | ${statusCell(r)} | ${enhanced} |`,
      )
    }
    out.push("")
  }

  out.push("### Legend")
  out.push("")
  out.push(
    "- ✅ pass — meets the WCAG floor. A `(below X:1 recommended)` note means it " +
      "clears the WCAG minimum but sits under our stricter recommended target " +
      "(see the safety-margin bullet above) — still a pass, just less headroom.",
  )
  out.push("- ❌ FAIL — below the WCAG floor.")
  out.push(
    "- AAA — the pair also clears the stricter 1.4.6 Enhanced floor. Informational: " +
      "the palette targets AA, so a blank cell here is not a finding.",
  )
  out.push(
    "- — exempt — outside WCAG scope (logotypes, disabled/inactive controls, " +
      "structural dividers that are not the sole means of identifying a component).",
  )
  out.push("")

  return out.join("\n") + "\n"
}
