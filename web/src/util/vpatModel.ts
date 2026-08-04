// The WCAG 2.2 conformance model the VPAT report renders from.
//
// A pure leaf (data + types only, no app imports, no fs) mirroring
// contrastModel.ts. Each entry is one applicable WCAG 2.2 success criterion with
// its conformance status, the KIND of evidence backing that status, and a
// remark. The report renderer (vpatReport.ts) and the integrity guard
// (vpatGuard.test.ts) both consume this, so a single edit here flows to every
// rendering.
//
// Status discipline (KTD5): a criterion may claim `supports` ONLY with an
// evidence tag — automation can't silently overclaim, and a human attestation is
// explicit. The contrast criteria (1.4.3/1.4.6/1.4.11) are deliberately left as
// a `contrast`-evidence placeholder here and RESOLVED from the live contrast
// audit in vpatReport.ts (KTD4), so the two reports can never disagree.

export type WcagPrinciple =
  "Perceivable" | "Operable" | "Understandable" | "Robust"

export type WcagLevel = "A" | "AA" | "AAA"

/** VPAT conformance verdict for one criterion. */
export type ConformanceLevel =
  "supports" | "partially" | "doesNotSupport" | "notApplicable" | "notEvaluated"

/**
 * What backs a status. `contrast` is computed from the contrast audit;
 * `automated` is a zero-violation tooling category; `manual` is a human
 * keyboard/screen-reader attestation; `architectural` justifies a `notApplicable`
 * from the 100%-client-side design (no server auth, sessions, or stored data).
 */
export type EvidenceKind = "contrast" | "automated" | "manual" | "architectural"

export type Criterion = {
  /** WCAG SC number, e.g. "1.4.3". Stable id used across renderings + the guard. */
  id: string
  name: string
  level: WcagLevel
  principle: WcagPrinciple
  status: ConformanceLevel
  /** Required whenever status is `supports` (the overclaim guard enforces this). */
  evidence?: EvidenceKind
  remark: string
}

// The three contrast criteria whose status vpatReport.ts overwrites from the
// live contrast audit. Listed here so the guard can assert the wiring and so a
// reader sees they are intentionally derived, not hand-set.
export const CONTRAST_CRITERION_IDS = ["1.4.3", "1.4.6", "1.4.11"] as const

const NOT_EVALUATED_REMARK =
  "Not yet formally assessed. Automated checks establish a floor; a manual " +
  "keyboard and screen-reader pass on the primary flows will set the final " +
  "conformance level."

// The applicable WCAG 2.2 Level A/AA criteria for the app (plus the three
// AAA contrast criteria already achieved). Grouped by principle. Contrast rows
// carry a placeholder status/evidence that vpatReport.ts replaces from the live
// audit; client-side-only rows are notApplicable with an architectural remark;
// the rest start notEvaluated until the manual assessment sets them.
export const CRITERIA: Criterion[] = [
  // ── Perceivable ────────────────────────────────────────────────────────────
  {
    id: "1.1.1",
    name: "Non-text Content",
    level: "A",
    principle: "Perceivable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "1.3.1",
    name: "Info and Relationships",
    level: "A",
    principle: "Perceivable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "1.3.2",
    name: "Meaningful Sequence",
    level: "A",
    principle: "Perceivable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "1.3.5",
    name: "Identify Input Purpose",
    level: "AA",
    principle: "Perceivable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "1.4.3",
    name: "Contrast (Minimum)",
    level: "AA",
    principle: "Perceivable",
    // Placeholder — resolved from the live contrast audit in vpatReport.ts.
    status: "supports",
    evidence: "contrast",
    remark: "Resolved from the automated contrast audit.",
  },
  {
    id: "1.4.6",
    name: "Contrast (Enhanced)",
    level: "AAA",
    principle: "Perceivable",
    status: "supports",
    evidence: "contrast",
    remark: "Resolved from the automated contrast audit.",
  },
  {
    id: "1.4.11",
    name: "Non-text Contrast",
    level: "AA",
    principle: "Perceivable",
    status: "supports",
    evidence: "contrast",
    remark: "Resolved from the automated contrast audit.",
  },
  {
    id: "1.4.4",
    name: "Resize Text",
    level: "AA",
    principle: "Perceivable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "1.4.10",
    name: "Reflow",
    level: "AA",
    principle: "Perceivable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "1.4.12",
    name: "Text Spacing",
    level: "AA",
    principle: "Perceivable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "1.4.13",
    name: "Content on Hover or Focus",
    level: "AA",
    principle: "Perceivable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  // ── Operable ─────────────────────────────────────────────────────────────
  {
    id: "2.1.1",
    name: "Keyboard",
    level: "A",
    principle: "Operable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "2.1.2",
    name: "No Keyboard Trap",
    level: "A",
    principle: "Operable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "2.4.1",
    name: "Bypass Blocks",
    level: "A",
    principle: "Operable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "2.4.3",
    name: "Focus Order",
    level: "A",
    principle: "Operable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "2.4.4",
    name: "Link Purpose (In Context)",
    level: "A",
    principle: "Operable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "2.4.6",
    name: "Headings and Labels",
    level: "AA",
    principle: "Operable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "2.4.7",
    name: "Focus Visible",
    level: "AA",
    principle: "Operable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "2.4.11",
    name: "Focus Not Obscured (Minimum)",
    level: "AA",
    principle: "Operable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "2.5.3",
    name: "Label in Name",
    level: "A",
    principle: "Operable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "2.5.8",
    name: "Target Size (Minimum)",
    level: "AA",
    principle: "Operable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  // ── Understandable ─────────────────────────────────────────────────────────
  {
    id: "3.1.1",
    name: "Language of Page",
    level: "A",
    principle: "Understandable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "3.2.3",
    name: "Consistent Navigation",
    level: "AA",
    principle: "Understandable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "3.2.4",
    name: "Consistent Identification",
    level: "AA",
    principle: "Understandable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "3.3.1",
    name: "Error Identification",
    level: "A",
    principle: "Understandable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "3.3.2",
    name: "Labels or Instructions",
    level: "A",
    principle: "Understandable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "3.3.7",
    name: "Redundant Entry",
    level: "A",
    principle: "Understandable",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "3.3.8",
    name: "Accessible Authentication (Minimum)",
    level: "AA",
    principle: "Understandable",
    status: "notEvaluated",
    remark:
      "Authentication is delegated entirely to GitHub's OAuth / device-code " +
      "flow; the app stores no password and imposes no cognitive-function test " +
      "of its own. Pending confirmation that the delegated flow is announced " +
      "accessibly.",
  },
  // ── Robust ─────────────────────────────────────────────────────────────────
  {
    id: "4.1.2",
    name: "Name, Role, Value",
    level: "A",
    principle: "Robust",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
  {
    id: "4.1.3",
    name: "Status Messages",
    level: "AA",
    principle: "Robust",
    status: "notEvaluated",
    remark: NOT_EVALUATED_REMARK,
  },
]

export const PRINCIPLE_ORDER: WcagPrinciple[] = [
  "Perceivable",
  "Operable",
  "Understandable",
  "Robust",
]
