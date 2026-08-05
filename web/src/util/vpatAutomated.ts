// The criterion -> backing-check binding (plan -004- U3).
//
// The single source that ties an `automated` VPAT verdict to the check that
// establishes it. vpatModel.ts flips exactly these criteria to `automated`
// Supports (U4); vpatAutomated.test.ts asserts each one's check is green and
// that the model never tags a criterion `automated` without an entry here (U5).
//
// Deliberately conservative (plan KTD4): a criterion is listed ONLY when a
// hermetic check fully establishes it in the current tree. Criteria that are
// only partially machine-verifiable (e.g. axe-clean on some primitives but not
// every flow) stay Not Evaluated until remediation (umbrella U7-U10) makes a
// whole-surface check green. Contrast criteria (1.4.3/1.4.6/1.4.11) are never
// listed here — they are derived from the contrast audit (backbone KTD4/KTD5).
//
// Pure data leaf: no DOM, no app imports beyond the criterion id space.

export type AutomatedBinding = {
  /** Short name of the hermetic check that backs this verdict (for the guard). */
  check: string
  /** The VPAT remark stating what was machine-checked (and any residual gap). */
  remark: string
}

export const AUTOMATED_CRITERIA: Record<string, AutomatedBinding> = {
  "3.1.1": {
    check: "documentHasLang(index.html + runtime <html lang>)",
    remark:
      "The page ships with a valid `lang` on the root <html> element and the " +
      "app updates it to match the active language at runtime. Verified " +
      "automatically (index.html carries lang; the i18n layer keeps " +
      "document.documentElement.lang in sync).",
  },
}
