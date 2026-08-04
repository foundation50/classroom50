// The WCAG 2.2 VPAT / ACR, in renderings that share one source of truth.
//
// `buildVpatReport()` produces the canonical JSON from vpatModel.ts, with the
// contrast criteria (1.4.3/1.4.6/1.4.11) DERIVED from the live contrast audit
// (KTD4) rather than hand-set — so the VPAT and the contrast report can never
// disagree. `renderVpatReport(edition)` renders the same criteria set as either
// the VPAT 2.5 WCAG edition or the Section 508 edition (KTD6); both are views
// over one model, never a second assessment. Pure (no fs, no app imports) so it
// stays a util/ leaf; the integrity guard (vpatGuard.test.ts) enforces the same
// facts, so every rendering reflects guarded state.

import { buildContrastAudit } from "./contrastReport"
import {
  CONTRAST_CRITERION_IDS,
  CRITERIA,
  PRINCIPLE_ORDER,
  type ConformanceLevel,
  type Criterion,
  type WcagPrinciple,
} from "./vpatModel"

export type VpatEdition = "wcag" | "508"

export type VpatReportJson = {
  /** Bump when the JSON shape changes so consumers can guard. */
  schema: "vpat-report/v1"
  standard: "WCAG 2.2"
  editions: ["2.5-wcag", "2.5-508"]
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

// Human-readable conformance words for both editions (VPAT 2.5 vocabulary).
const CONFORMANCE_WORD: Record<ConformanceLevel, string> = {
  supports: "Supports",
  partially: "Partially Supports",
  doesNotSupport: "Does Not Support",
  notApplicable: "Not Applicable",
  notEvaluated: "Not Evaluated",
}

/**
 * Derive the contrast criteria's conformance from the live contrast audit.
 * `allPass` → Supports (the audit guarantees every enforced pair meets its
 * floor); otherwise Partially Supports with the failing count. This is the only
 * place the contrast criteria's status is set (KTD4). Injectable for testing.
 */
function contrastStatus(allPass: boolean): {
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
  return {
    status: "partially",
    remark:
      "The automated contrast audit reports one or more pairs below the WCAG " +
      "floor. See /accessibility for the failing pairs.",
  }
}

/** The canonical structured VPAT. Deterministic for a given model + date. */
export function buildVpatReport(
  now = new Date(),
  contrastAllPass = buildContrastAudit(now).summary.allPass,
): VpatReportJson {
  const derived = contrastStatus(contrastAllPass)
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
    editions: ["2.5-wcag", "2.5-508"],
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

function criterionRow(c: Criterion): string {
  const remark = c.remark.replace(/\|/g, "\\|")
  return `| ${c.id} ${c.name} | ${c.level} | ${CONFORMANCE_WORD[c.status]} | ${remark} |`
}

// Preamble shared by both editions: product, date, evaluation methods, and the
// honest automated-vs-manual boundary a reviewer needs to weight the claims.
function preamble(report: VpatReportJson, editionLabel: string): string[] {
  return [
    `# Accessibility Conformance Report — ${report.product}`,
    "",
    `**Format:** VPAT® 2.5 — ${editionLabel}`,
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

function renderWcagEdition(report: VpatReportJson): string {
  const out: string[] = [
    ...preamble(report, "WCAG Edition"),
    summaryLine(report),
    "",
  ]
  for (const principle of PRINCIPLE_ORDER) {
    const rows = criteriaFor(report, principle)
    if (rows.length === 0) continue
    out.push(`## ${principle}`)
    out.push("")
    out.push(
      "| Criterion | Level | Conformance Level | Remarks and Explanations |",
    )
    out.push("| --- | --- | --- | --- |")
    for (const c of rows) out.push(criterionRow(c))
    out.push("")
  }
  return out.join("\n") + "\n"
}

// Section 508 chapter → the WCAG criteria that satisfy it. The 508 edition
// re-presents the SAME criterion verdicts under the 508 chapter structure; no
// criterion is re-assessed (KTD6). Chapter 4 (Hardware) has no web analog.
const SECTION_508_CHAPTERS: {
  chapter: string
  criterionIds: string[]
  hardwareNa?: boolean
}[] = [
  {
    chapter: "Chapter 3: Functional Performance Criteria",
    // Reported via the WCAG criteria that carry them for a web app.
    criterionIds: ["1.1.1", "1.4.3", "1.4.11", "2.1.1", "2.4.7"],
  },
  { chapter: "Chapter 4: Hardware", criterionIds: [], hardwareNa: true },
  {
    chapter: "Chapter 5: Software",
    criterionIds: CRITERIA.map((c) => c.id),
  },
  {
    chapter: "Chapter 6: Support Documentation and Services",
    criterionIds: ["3.1.1", "3.2.3", "3.2.4"],
  },
]

function renderSection508Edition(report: VpatReportJson): string {
  const byId = new Map(report.criteria.map((c) => [c.id, c]))
  const out: string[] = [
    ...preamble(report, "Section 508 Edition"),
    summaryLine(report),
    "",
    "Section 508 incorporates WCAG 2.2 by reference; each chapter below reports " +
      "the same criterion verdicts as the WCAG edition, re-presented under the " +
      "508 chapter structure.",
    "",
  ]
  for (const { chapter, criterionIds, hardwareNa } of SECTION_508_CHAPTERS) {
    out.push(`## ${chapter}`)
    out.push("")
    if (hardwareNa) {
      out.push(
        "Not Applicable — Classroom50 is a browser-based web application with " +
          "no hardware component.",
      )
      out.push("")
      continue
    }
    out.push(
      "| Criterion | Level | Conformance Level | Remarks and Explanations |",
    )
    out.push("| --- | --- | --- | --- |")
    for (const id of criterionIds) {
      const c = byId.get(id)
      if (c) out.push(criterionRow(c))
    }
    out.push("")
  }
  return out.join("\n") + "\n"
}

/** Render the Markdown ACR for the requested edition — derived from one model. */
export function renderVpatReport(
  edition: VpatEdition,
  now = new Date(),
): string {
  const report = buildVpatReport(now)
  return edition === "wcag"
    ? renderWcagEdition(report)
    : renderSection508Edition(report)
}
