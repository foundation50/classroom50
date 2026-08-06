// The WCAG 2.2 VPAT / ACR, in renderings that share one source of truth.
//
// `buildVpatReport()` produces the canonical JSON from vpatModel.ts, with the
// contrast criteria (1.4.3/1.4.6/1.4.11) DERIVED from the live contrast audit
// (KTD4) rather than hand-set — so the VPAT and the contrast report can never
// disagree. `renderVpatReport(edition)` renders the same criteria set as either
// the VPAT 2.5Rev WCAG edition or the INT edition (KTD6); both are views over
// one model, never a second assessment. The INT edition (not 508) is the second
// edition because ITI's 508 edition incorporates WCAG 2.0, while INT carries
// WCAG 2.2 alongside 508 + EN 301 549 — so our WCAG 2.2 work maps correctly to
// INT and still serves a US procurement office. Pure (no fs, no app imports) so
// it stays a util/ leaf; the integrity guard (vpatGuard.test.ts) enforces the
// same facts, so every rendering reflects guarded state.

import { buildContrastAudit } from "./contrastReport"
import {
  CONFORMANCE_LABEL,
  CONTRAST_CRITERION_IDS,
  CRITERIA,
  PRINCIPLE_ORDER,
  type ConformanceLevel,
  type Criterion,
  type WcagPrinciple,
} from "./vpatModel"

export type VpatEdition = "wcag" | "int"

export type VpatReportJson = {
  /** Bump when the JSON shape changes so consumers can guard. */
  schema: "vpat-report/v1"
  standard: "WCAG 2.2"
  editions: ["2.5Rev-wcag", "2.5Rev-int"]
  target: "AA"
  product: string
  generated: string
  summary: {
    total: number
    byStatus: Record<ConformanceLevel, number>
  }
  criteria: Criterion[]
}

const PRODUCT = "Classroom50 web app"

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
        "UI-component pair meets its WCAG floor (text at the AAA 7:1 / 4.5:1 " +
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

/** The canonical structured VPAT. Deterministic for a given model + date. */
export function buildVpatReport(
  now = new Date(),
  contrast: { allPass: boolean; failures: number } = (() => {
    const s = buildContrastAudit(now).summary
    return { allPass: s.allPass, failures: s.failures }
  })(),
): VpatReportJson {
  const derived = contrastStatus(contrast.allPass, contrast.failures)
  const contrastIds = new Set<string>(CONTRAST_CRITERION_IDS)

  const criteria: Criterion[] = CRITERIA.map((c) =>
    contrastIds.has(c.id)
      ? {
          ...c,
          status: derived.status,
          evidence: "contrast",
          remark: derived.remark,
        }
      : { ...c },
  )

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
    editions: ["2.5Rev-wcag", "2.5Rev-int"],
    target: "AA",
    product: PRODUCT,
    generated: now.toISOString().slice(0, 10),
    summary: { total: criteria.length, byStatus },
    criteria,
  }
}

/** Serialize the canonical VPAT as pretty JSON (the emitted artifact). */
export function renderVpatJson(now = new Date()): string {
  return JSON.stringify(buildVpatReport(now), null, 2) + "\n"
}

function criteriaFor(
  report: VpatReportJson,
  principle: WcagPrinciple,
): Criterion[] {
  return report.criteria.filter((c) => c.principle === principle)
}

function criterionRow(c: Criterion, fallbackDate: string): string {
  const remark = c.remark.replace(/\|/g, "\\|")
  // Manual rows carry their own assessed date; the contrast rows are re-derived
  // every build, so they take the report's generation date.
  const date = c.assessed ?? fallbackDate
  return `| ${c.id} ${c.name} | ${c.level} | ${CONFORMANCE_LABEL[c.status]} | ${date} | ${remark} |`
}

// Preamble shared by both editions: product, date, evaluation methods, and the
// honest automated-vs-manual boundary a reviewer needs to weight the claims.
function preamble(report: VpatReportJson, editionLabel: string): string[] {
  return [
    `# Accessibility Conformance Report — ${report.product}`,
    "",
    `**Format:** VPAT® 2.5Rev — ${editionLabel}`,
    `**Standard:** WCAG ${report.standard.replace("WCAG ", "")}, target Level ${report.target}`,
    `**Product:** ${report.product}`,
    `**Report date:** ${report.generated}`,
    "",
    "**Evaluation methods:** Automated checks (color-contrast audit computed " +
      "per rendered pixel and guarded in CI; static and axe-based rule scans) " +
      "establish a floor; criteria backed only by automation are marked " +
      "provisionally and a manual keyboard + screen-reader pass sets the final " +
      "conformance level. Criteria still awaiting that pass are shown as *Not " +
      "Evaluated* rather than claimed.",
    "",
    "**Conformance terms:** *Supports* — meets the criterion. *Partially " +
      "Supports* — meets it with exceptions. *Does Not Support* — does not meet " +
      "it. *Not Applicable* — the criterion does not apply. *Not Evaluated* — " +
      "not yet assessed.",
    "",
  ]
}

function summaryLine(report: VpatReportJson): string {
  const s = report.summary.byStatus
  return (
    `**Summary (${report.summary.total} applicable criteria):** ` +
    `${s.supports} Supports, ${s.partially} Partially, ` +
    `${s.doesNotSupport} Does Not Support, ${s.notApplicable} Not Applicable, ` +
    `${s.notEvaluated} Not Evaluated.`
  )
}

// The per-principle WCAG 2.2 conformance tables, shared verbatim by both
// editions — they differ only in preamble/intro, never in the verdicts.
function principleTables(report: VpatReportJson): string[] {
  const out: string[] = []
  for (const principle of PRINCIPLE_ORDER) {
    const rows = criteriaFor(report, principle)
    if (rows.length === 0) continue
    out.push(`## ${principle}`)
    out.push("")
    out.push(
      "| Criterion | Level | Conformance Level | Assessed | Remarks and Explanations |",
    )
    out.push("| --- | --- | --- | --- | --- |")
    for (const c of rows) out.push(criterionRow(c, report.generated))
    out.push("")
  }
  return out
}

function renderWcagEdition(report: VpatReportJson): string {
  return (
    [
      ...preamble(report, "WCAG Edition"),
      summaryLine(report),
      "",
      ...principleTables(report),
    ].join("\n") + "\n"
  )
}

// The INT edition (VPAT 2.5Rev INT) incorporates Section 508, EN 301 549, and
// WCAG 2.2 in one report. Because our conformance evidence is expressed against
// WCAG 2.2 (the standard the app is actually tested to), the INT edition
// presents the same per-principle WCAG 2.2 tables as the WCAG edition, under an
// INT framing that states how the three standards relate. No criterion is
// re-assessed (KTD6) — a US 508 / EU procurement office reads the same verdicts.
function renderIntEdition(report: VpatReportJson): string {
  return (
    [
      ...preamble(report, "INT Edition (Section 508 + EN 301 549 + WCAG 2.2)"),
      summaryLine(report),
      "",
      "The INT edition incorporates three standards. This report expresses " +
        "conformance against **WCAG 2.2** — the standard the product is tested " +
        "to — which the other two reference: **Section 508** (US) incorporates " +
        "WCAG 2.0 Level A/AA and **EN 301 549** (EU) incorporates WCAG 2.1; both " +
        "are subsets of the WCAG 2.2 criteria reported below, so each verdict " +
        "applies to the corresponding 508 / EN 301 549 provision. Chapter 4 " +
        "(Hardware) of Section 508 is Not Applicable — Classroom50 is a " +
        "browser-based web application with no hardware component.",
      "",
      ...principleTables(report),
    ].join("\n") + "\n"
  )
}

/** Render the Markdown ACR for the requested edition — derived from one model. */
export function renderVpatReport(
  edition: VpatEdition,
  now = new Date(),
): string {
  const report = buildVpatReport(now)
  return edition === "wcag"
    ? renderWcagEdition(report)
    : renderIntEdition(report)
}
