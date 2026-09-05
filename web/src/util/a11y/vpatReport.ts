// The WCAG 2.2 VPAT / ACR, in renderings that share one source of truth.
//
// `buildVpatReport()` produces the canonical JSON from vpatModel.ts, with the
// contrast criteria (1.4.3/1.4.6/1.4.11) DERIVED from the live contrast audit
// (KTD4) rather than hand-set — so the VPAT and the contrast report can never
// disagree. `renderVpatReport()` renders that criteria set as the VPAT 2.5Rev
// WCAG edition — a view over the model, never a second assessment. Pure (no fs,
// no app imports) so it stays a util/ leaf; the integrity guard
// (vpatGuard.test.ts) enforces the same facts, so every rendering reflects
// guarded state.

import { buildContrastAudit, renderContrastReport } from "./contrastReport.ts"
import {
  CONFORMANCE_LABEL,
  CONTRAST_CRITERION_IDS,
  CRITERIA,
  ENHANCED_CRITERION_ID,
  PRINCIPLE_ORDER,
  type ConformanceLevel,
  type Criterion,
  type WcagPrinciple,
} from "./vpatModel.ts"

export type VpatReportJson = {
  /** Bump when the JSON shape changes so consumers can guard. */
  schema: "vpat-report/v1"
  standard: "WCAG 2.2"
  /**
   * The WCAG versions a reviewer can file this report against. WCAG 2.2 A/AA is
   * a superset of the 2.0 and 2.1 A/AA criteria (4.1.1 Parsing, dropped in 2.2,
   * keeps its row), so one assessment answers all three.
   */
  wcagVersions: typeof WCAG_VERSIONS
  editions: ["2.5Rev-wcag"]
  target: "AA"
  vendor: string
  product: string
  /** Release the report describes (semver or tag); absent for an untagged build. */
  version?: string
  generated: string
  summary: {
    total: number
    byStatus: Record<ConformanceLevel, number>
  }
  criteria: Criterion[]
}

// The VPAT title format is "[Company Name] Accessibility Conformance Report";
// the product name stands in for the company, as is usual for open source.
const VENDOR = "Classroom 50"
const PRODUCT = "Classroom 50 web app"
const PRODUCT_DESCRIPTION =
  "Classroom 50 is a free, open-source web app for creating and grading " +
  "programming assignments on GitHub: teachers manage classrooms, rosters, " +
  "assignments, and autograded submissions; students accept and submit " +
  "assignments. It runs entirely in the browser against the GitHub API, with " +
  "no server of its own. This report covers the web app at classroom50.org; " +
  "the companion command-line tools are out of scope."
const CONTACT_URL =
  "https://github.com/foundation50/classroom50/issues/new?template=2_accessibility_report.yml"
export const WCAG_VERSIONS = ["2.0", "2.1", "2.2"] as const

/** Report metadata the caller knows and the pure renderer cannot read itself. */
export type VpatReportOptions = {
  /** App release the report describes; the Vite build and CI generator pass it. */
  version?: string
}

/**
 * Derive the contrast criteria's conformance from the live contrast audit.
 * `allPass` → Supports (the audit guarantees every enforced pair meets its
 * floor); otherwise Partially Supports, naming the failing-pair count. This is
 * the only place the contrast criteria's status is set (KTD4). Injectable for
 * testing.
 */
function contrastStatus(
  allPass: boolean,
  failures: number,
): {
  status: ConformanceLevel
  remark: string
} {
  if (allPass) {
    return {
      status: "supports",
      remark:
        "Verified by the automated contrast audit: every audited text and " +
        "UI-component pair meets its WCAG floor (text at the AA 4.5:1 / 3:1 " +
        "level). See the live report at /accessibility. Guarded in CI.",
    }
  }
  const pairs = failures === 1 ? "pair" : "pairs"
  return {
    status: "partially",
    remark:
      `The automated contrast audit reports ${failures} ${pairs} below the ` +
      "WCAG floor. See /accessibility for the failing pairs.",
  }
}

/**
 * Derive 1.4.6 (Enhanced, AAA) from the same audit's AAA tally. The palette is
 * GitHub Primer verbatim and Primer's primitives are tuned to AA, so this row is
 * expected to be Partially Supports — but it stays DERIVED rather than hand-set,
 * so the claim always matches the measured palette.
 */
function enhancedStatus(
  allPassEnhanced: boolean,
  enhancedMisses: number,
): {
  status: ConformanceLevel
  remark: string
} {
  if (allPassEnhanced) {
    return {
      status: "supports",
      remark:
        "Verified by the automated contrast audit: every audited pair also " +
        "clears the Enhanced 7:1 / 4.5:1 floors. See /accessibility.",
    }
  }
  const pairs = enhancedMisses === 1 ? "pair" : "pairs"
  return {
    status: "partially",
    remark:
      "The palette follows GitHub's Primer primitives, which target Level AA; " +
      `${enhancedMisses} audited ${pairs} therefore meet 1.4.3 (AA) but not the ` +
      "Enhanced 7:1 / 4.5:1 floors. The per-pair AAA column at /accessibility " +
      "shows which. AA is the product's stated conformance target.",
  }
}

/** The canonical structured VPAT. Deterministic for a given model + date. */
export function buildVpatReport(
  now = new Date(),
  contrast: {
    allPass: boolean
    failures: number
    allPassEnhanced: boolean
    enhancedMisses: number
  } = (() => {
    const s = buildContrastAudit(now).summary
    return {
      allPass: s.allPass,
      failures: s.failures,
      allPassEnhanced: s.allPassEnhanced,
      enhancedMisses: s.enhancedMisses,
    }
  })(),
  options: VpatReportOptions = {},
): VpatReportJson {
  const derived = contrastStatus(contrast.allPass, contrast.failures)
  // 1.4.6 is the AAA tier: same audit, stricter floors, so it gets its own
  // derivation rather than inheriting the AA verdict.
  const derivedEnhanced = enhancedStatus(
    contrast.allPassEnhanced,
    contrast.enhancedMisses,
  )
  const contrastIds = new Set<string>(CONTRAST_CRITERION_IDS)

  const criteria: Criterion[] = CRITERIA.map((c): Criterion => {
    if (!contrastIds.has(c.id)) return { ...c }
    const d = c.id === ENHANCED_CRITERION_ID ? derivedEnhanced : derived
    return { ...c, status: d.status, evidence: "contrast", remark: d.remark }
  }).sort(compareCriterionIds)

  const byStatus = criteria.reduce(
    (acc, c) => {
      acc[c.status] += 1
      return acc
    },
    {
      supports: 0,
      partially: 0,
      doesNotSupport: 0,
      notApplicable: 0,
      notEvaluated: 0,
    } as Record<ConformanceLevel, number>,
  )

  return {
    schema: "vpat-report/v1",
    standard: "WCAG 2.2",
    wcagVersions: WCAG_VERSIONS,
    editions: ["2.5Rev-wcag"],
    target: "AA",
    vendor: VENDOR,
    product: PRODUCT,
    ...(options.version ? { version: options.version } : {}),
    generated: now.toISOString().slice(0, 10),
    summary: { total: criteria.length, byStatus },
    criteria,
  }
}

/** Serialize the canonical VPAT as pretty JSON (the emitted artifact). */
export function renderVpatJson(
  now = new Date(),
  options: VpatReportOptions = {},
): string {
  return (
    JSON.stringify(buildVpatReport(now, undefined, options), null, 2) + "\n"
  )
}

function criteriaFor(
  report: VpatReportJson,
  principle: WcagPrinciple,
): Criterion[] {
  return report.criteria.filter((c) => c.principle === principle)
}

/**
 * The criterion cell as the VPAT WCAG template writes it: id, short title, and
 * for criteria that exist only in some WCAG versions the versions they belong
 * to, so a reviewer filing against one version can see which rows to disregard.
 */
export function criterionLabel(
  c: Pick<Criterion, "id" | "name" | "since" | "until">,
) {
  const versions =
    c.until === "2.1"
      ? " (2.0 and 2.1 only)"
      : c.since === "2.1"
        ? " (2.1 and 2.2)"
        : c.since === "2.2"
          ? " (2.2 only)"
          : ""
  return `${c.id} ${c.name}${versions}`
}

// WCAG ids sort numerically by segment (1.4.4 before 1.4.10), not as strings.
export function compareCriterionIds(a: { id: string }, b: { id: string }) {
  const pa = a.id.split(".").map(Number)
  const pb = b.id.split(".").map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

// Remarks are cell content in a Markdown table: a pipe would split the cell and
// a raw tag like <video> would be swallowed as inline HTML by most renderers.
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function criterionRow(c: Criterion, fallbackDate: string): string {
  // Manual rows carry their own assessed date. Contrast and architectural rows
  // are re-derived or re-guarded on every build (the contrast audit and
  // vpatArchitectural.test.ts), so they take the report's generation date.
  const date = c.assessed ?? fallbackDate
  return `| ${criterionLabel(c)} | ${c.level} | ${CONFORMANCE_LABEL[c.status]} | ${date} | ${escapeCell(c.remark)} |`
}

// Level A/AA rows still Not Evaluated. The ITI terms reserve Not Evaluated for
// Level AAA, so using it on an A/AA row is a deviation the Notes section must
// declare (the template requires that) until the manual assessment lands.
export function pendingAaRows(criteria: Criterion[]): Criterion[] {
  return criteria.filter(
    (c) => c.level !== "AAA" && c.status === "notEvaluated",
  )
}

/** The Notes bullet declaring the deviation, or null once nothing is pending. */
export function deviationNote(criteria: Criterion[]): string | null {
  const pending = pendingAaRows(criteria)
  if (pending.length === 0) return null
  return (
    `- Deviation from the ITI terms: ${pending.length} Level A/AA criteria ` +
    `(${pending.map((c) => c.id).join(", ")}) are marked Not Evaluated ` +
    "because their manual keyboard and screen-reader assessment is still in " +
    "progress. ITI reserves Not Evaluated for Level AAA. Those rows carry no " +
    "conformance claim; they will be updated as the assessment completes."
  )
}

// The report header, with every field the VPAT 2.5Rev "Essential Requirements
// for Authors" list as mandatory: title in the "[Company] Accessibility
// Conformance Report" form, template version, product/version, date, product
// description, contact, notes, evaluation methods, applicable standards, and
// the ITI term definitions.
function preamble(report: VpatReportJson): string[] {
  const deviation = deviationNote(report.criteria)
  const productLine = report.version
    ? `${report.product}, version ${report.version}`
    : report.product
  return [
    `# ${report.vendor} Accessibility Conformance Report`,
    "",
    "**WCAG Edition** (Based on VPAT® Version 2.5Rev)",
    "",
    `**Name of Product/Version:** ${productLine}`,
    "",
    `**Report Date:** ${report.generated}`,
    "",
    `**Product Description:** ${PRODUCT_DESCRIPTION}`,
    "",
    `**Contact Information:** Open an accessibility report at ${CONTACT_URL} ` +
      "(the maintainers answer there in public), or use the same link from " +
      "the Accessibility page in the app.",
    "",
    "**Notes:**",
    "",
    "- This report is generated from the app's source on every build, so the " +
      "Report Date is the build date and the version is the release it " +
      "describes. Earlier reports are superseded; the Assessed column records " +
      "when each manual verdict was taken.",
    "- The conformance target is WCAG 2.2 Level AA. Level AAA is not " +
      "evaluated except 1.4.6 Contrast (Enhanced), reported for transparency " +
      "only.",
    "- Criteria the product cannot trigger (for example, captions when there " +
      "is no media) are marked Not Applicable with the reason. Per the ITI " +
      "note on WCAG conformance, such criteria may equally be read as " +
      "satisfied.",
    ...(deviation ? [deviation] : []),
    "",
    "**Evaluation Methods Used:** Testing is performed by the product's " +
      "maintainers, who know its teacher and student flows. Automated checks " +
      "run on every build and are enforced in CI: a color-contrast audit " +
      "computed per rendered pixel for both themes, axe-core rule scans, and " +
      "real-browser checks of reflow, text resize, text spacing, target size, " +
      "and form-field semantics on the shared UI primitives. Manual testing is " +
      "a keyboard-only pass plus accessibility-tree inspection in Chromium " +
      "(and a screen-reader listen where noted) on the primary flows; each " +
      "manual remark names the flow and method used. Criteria backed only by " +
      "automation say so in their remark.",
    "",
    "## Applicable Standards/Guidelines",
    "",
    "This report covers the degree of conformance for the following " +
      "accessibility standard/guidelines:",
    "",
    "| Standard/Guideline | Included In Report |",
    "| --- | --- |",
    ...report.wcagVersions.map(
      (v) =>
        `| Web Content Accessibility Guidelines ${v} | Level A (Yes), ` +
        "Level AA (Yes), Level AAA (No) |",
    ),
    "",
    "WCAG 2.2 Level A and AA are a superset of WCAG 2.0 and 2.1 Level A and " +
      "AA, so one assessment answers all three versions. Rows marked " +
      '"(2.1 and 2.2)" or "(2.2 only)" do not apply to earlier versions; ' +
      "4.1.1 Parsing applies only to WCAG 2.0 and 2.1.",
    "",
    "## Terms",
    "",
    "The terms used in the Conformance Level information are defined as follows:",
    "",
    "- **Supports:** The functionality of the product has at least one method " +
      "that meets the criterion without known defects or meets with " +
      "equivalent facilitation.",
    "- **Partially Supports:** Some functionality of the product does not " +
      "meet the criterion.",
    "- **Does Not Support:** The majority of product functionality does not " +
      "meet the criterion.",
    "- **Not Applicable:** The criterion is not relevant to the product.",
    "- **Not Evaluated:** The product has not been evaluated against the " +
      "criterion. This can only be used in WCAG Level AAA criteria." +
      (deviation ? " See Notes for this report's use of it." : ""),
    "",
  ]
}

function summaryLine(report: VpatReportJson): string {
  const s = report.summary.byStatus
  return (
    `**Summary (${report.summary.total} criteria):** ` +
    `${s.supports} Supports, ${s.partially} Partially Supports, ` +
    `${s.doesNotSupport} Does Not Support, ${s.notApplicable} Not Applicable, ` +
    `${s.notEvaluated} Not Evaluated.`
  )
}

// The conformance tables. The ITI template splits by level (A, AA, AAA) and
// allows combining into one table in numerical order; we group by WCAG
// principle, which keeps the same numerical order within each guideline and
// matches the interactive /accessibility view.
function principleTables(report: VpatReportJson): string[] {
  const out: string[] = [
    "## WCAG 2.x Report",
    "",
    "Note: When reporting on conformance with the WCAG 2.x Success Criteria, " +
      "they are scoped for full pages, complete processes, and " +
      "accessibility-supported ways of using technology as documented in the " +
      "WCAG 2.0 Conformance Requirements.",
    "",
  ]
  for (const principle of PRINCIPLE_ORDER) {
    const rows = criteriaFor(report, principle)
    if (rows.length === 0) continue
    out.push(`### ${principle}`)
    out.push("")
    out.push(
      "| Criteria | Level | Conformance Level | Assessed | Remarks and Explanations |",
    )
    out.push("| --- | --- | --- | --- | --- |")
    for (const c of rows) out.push(criterionRow(c, report.generated))
    out.push("")
  }
  return out
}

/** Render the Markdown ACR (VPAT 2.5Rev WCAG edition) — derived from one model. */
export function renderVpatReport(
  now = new Date(),
  options: VpatReportOptions = {},
): string {
  const report = buildVpatReport(now, undefined, options)
  return (
    [
      ...preamble(report),
      summaryLine(report),
      "",
      ...principleTables(report),
    ].join("\n") + "\n"
  )
}

// The complete accessibility report in one file: the VPAT and the contrast
// audit, in the order a reviewer reads them (conformance first, then the
// contrast evidence the contrast criteria derive from). A rendering over the
// same single sources as the individual downloads — never a separate assessment
// — so it can't disagree with them.
export function renderCombinedReport(
  now = new Date(),
  options: VpatReportOptions = {},
): string {
  const sections = [renderVpatReport(now, options), renderContrastReport(now)]
  // A horizontal rule between the two documents so their headings don't read
  // as one continuous report when concatenated.
  return sections.join("\n---\n\n")
}
