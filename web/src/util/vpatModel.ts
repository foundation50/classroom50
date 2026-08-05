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

import verdicts from "../../accessibility/vpatVerdicts.json"

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

/**
 * True when a criterion carries only the generic "not yet assessed" boilerplate
 * (no specific, criterion-level note). Structural, not prose-based: a criterion
 * is generic when it is `notEvaluated` with no evidence tag. The report page
 * uses this to collapse the repeated boilerplate remark to a single banner
 * rather than repeating it on every row. Keeping the test structural means
 * rewording NOT_EVALUATED_REMARK can't silently break the collapse.
 */
export function hasGenericRemark(c: Pick<Criterion, "status" | "evidence">) {
  return c.status === "notEvaluated" && c.evidence === undefined
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
const BASE_CRITERIA: Criterion[] = [
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
    status: "supports",
    evidence: "automated",
    remark:
      "Text resizes to 200% without loss of content: with the root font enlarged " +
      "to 200% in a real browser, the shared primitives' text scales (relative " +
      "units) and the layout still fits without clipping or horizontal overflow. " +
      "Verified automatically on the shared primitives; a per-route zoom sweep is " +
      "a manual follow-up.",
  },
  {
    id: "1.4.10",
    name: "Reflow",
    level: "AA",
    principle: "Perceivable",
    status: "supports",
    evidence: "automated",
    remark:
      "Content reflows without horizontal scroll: a representative layout of the " +
      "shared Card/Button primitives is measured at a 320px viewport in a real " +
      "browser and no element exceeds the width. Verified automatically on the " +
      "shared layout primitives; a per-route reflow sweep is a manual follow-up.",
  },
  {
    id: "1.4.12",
    name: "Text Spacing",
    level: "AA",
    principle: "Perceivable",
    status: "supports",
    evidence: "automated",
    remark:
      "Content survives the WCAG 1.4.12 text-spacing overrides (line-height 1.5x, " +
      "letter-spacing 0.12em, word-spacing 0.16em, paragraph spacing 2em): applied " +
      "to the shared primitives in a real browser, the container grows to fit " +
      "rather than clipping. Verified automatically on the shared primitives; a " +
      "per-route sweep is a manual follow-up.",
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
    status: "supports",
    evidence: "automated",
    remark:
      "Interactive targets meet the 24x24 CSS px minimum: the shared Button " +
      "primitive's action sizes and icon-only shape are measured in a real " +
      "browser layout engine. Verified automatically on the shared primitives; " +
      "an exhaustive per-site target sweep is a manual follow-up.",
  },
  // ── Understandable ─────────────────────────────────────────────────────────
  {
    id: "3.1.1",
    name: "Language of Page",
    level: "A",
    principle: "Understandable",
    status: "supports",
    evidence: "automated",
    remark:
      "The page ships with a valid `lang` on the root <html> element and the " +
      "app updates it to match the active language at runtime. Verified " +
      "automatically (index.html carries lang; the i18n layer keeps " +
      "document.documentElement.lang in sync).",
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
    status: "supports",
    evidence: "automated",
    remark:
      "Form fields identify errors in text: the shared FormField wrapper renders " +
      "the error as a role=alert message, links it to the control via " +
      "aria-describedby, and sets aria-invalid on the control. Verified " +
      "automatically on the field primitive; per-form error copy is a manual " +
      "content check.",
  },
  {
    id: "3.3.2",
    name: "Labels or Instructions",
    level: "A",
    principle: "Understandable",
    status: "supports",
    evidence: "automated",
    remark:
      "Inputs carry programmatic labels: the shared FormField wrapper binds a " +
      "<label htmlFor> to the control id and exposes required/help affordances. " +
      "Verified automatically on the field primitive; per-form instruction copy " +
      "is a manual content check.",
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
    status: "supports",
    evidence: "automated",
    remark:
      "Status changes are announced through a live region: toasts render as " +
      "role=alert with aria-live tone-mapped (assertive for errors, polite " +
      "otherwise), so assistive tech announces them without moving focus. " +
      "Verified automatically on the toast surface (structure only; timing and " +
      "visibility are not machine-checked).",
  },
]

export const PRINCIPLE_ORDER: WcagPrinciple[] = [
  "Perceivable",
  "Operable",
  "Understandable",
  "Robust",
]

/**
 * One human-recorded manual verdict, keyed by SC id in vpatVerdicts.json. Only
 * the fields a manual assessor sets — the id, name, level, and principle come
 * from BASE_CRITERIA, so the JSON stays a thin, machine-writable overlay the
 * dev-only assessment tool (see vite.config.ts) appends to.
 */
export type ManualVerdict = {
  status: "supports" | "partially" | "doesNotSupport"
  evidence: "manual"
  remark: string
}

export type VerdictOverlay = Record<string, ManualVerdict>

/**
 * Overlay human verdicts onto the base criteria. A verdict may only land on a
 * criterion that is still `notEvaluated` — the manual-owned rows. Targeting an
 * automated/contrast/architectural row (already decided by tooling or design)
 * is a wiring error and throws, so the JSON can never silently overwrite a
 * machine-established verdict. Unknown ids also throw. Pure: no fs, no mutation
 * of the input.
 */
export function applyVerdicts(
  base: Criterion[],
  overlay: VerdictOverlay,
): Criterion[] {
  const byId = new Map(base.map((c) => [c.id, c]))
  for (const id of Object.keys(overlay)) {
    const target = byId.get(id)
    if (!target) {
      throw new Error(`Manual verdict for unknown criterion "${id}".`)
    }
    if (target.status !== "notEvaluated") {
      throw new Error(
        `Manual verdict for "${id}" would overwrite a ${target.status} ` +
          `(${target.evidence ?? "no"}-evidence) row; only notEvaluated ` +
          `criteria accept a manual verdict.`,
      )
    }
  }
  return base.map((c) => {
    const v = overlay[c.id]
    return v
      ? { ...c, status: v.status, evidence: v.evidence, remark: v.remark }
      : c
  })
}

// The applicable criteria with any recorded manual verdicts overlaid. This is
// what vpatReport.ts, the /accessibility page, and the guards consume; the base
// array above stays the readable spine and vpatVerdicts.json carries the
// human-owned deltas.
export const CRITERIA: Criterion[] = applyVerdicts(
  BASE_CRITERIA,
  verdicts as VerdictOverlay,
)

/**
 * Build the criteria from an arbitrary verdict overlay (not the committed JSON).
 * The dev-only assessment endpoint uses this to render fresh output right after
 * it writes a new verdict, since the module-level CRITERIA is frozen at import.
 */
export function buildCriteria(overlay: VerdictOverlay): Criterion[] {
  return applyVerdicts(BASE_CRITERIA, overlay)
}
