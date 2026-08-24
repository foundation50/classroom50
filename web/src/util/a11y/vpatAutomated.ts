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
  /**
   * The backing check needs real Chromium, so it runs on the PR CI browser lane
   * but not in the `test:node`-only deploy gate. The guard below then requires
   * the remark to disclose that (see BROWSER_CI_DISCLOSURE).
   */
  browserBacked?: boolean
}

// The disclosure every browserBacked remark must carry so a manual redeploy of
// an un-CI'd ref can't ship a "Supports" claim the browser-free deploy gate
// never re-verified. Asserted by vpatAutomated.test.ts (which runs in that gate).
export const BROWSER_CI_DISCLOSURE =
  "verified on the CI browser lane (not re-run by the browser-free deploy gate)"

export const AUTOMATED_CRITERIA: Record<string, AutomatedBinding> = {
  "3.1.1": {
    check:
      "index.html declares <html lang> (vpatAutomated.test.ts) + i18n keeps " +
      "document.documentElement.lang in sync (a11yStructural.test.tsx)",
    remark:
      "The page ships with a valid `lang` on the root <html> element and the " +
      "app updates it to match the active language at runtime. Verified " +
      "automatically (index.html carries lang; the i18n layer keeps " +
      "document.documentElement.lang in sync).",
  },
  "3.3.1": {
    check:
      "FormField renders role=alert error text, wires it to the control via " +
      "aria-describedby, and marks the control aria-invalid (a11yStructural.test.tsx)",
    remark:
      "Form fields identify errors in text: the shared FormField wrapper renders " +
      "the error as a role=alert message, links it to the control via " +
      "aria-describedby, and sets aria-invalid on the control. Verified " +
      "automatically on the field primitive; per-form error copy is a manual " +
      "content check.",
  },
  "3.3.2": {
    check:
      "FormField associates <label htmlFor> with the control id and exposes the " +
      "help affordance's accessible name (a11yStructural.test.tsx)",
    remark:
      "Inputs carry programmatic labels: the shared FormField wrapper binds a " +
      "<label htmlFor> to the control id and exposes required/help affordances. " +
      "Verified automatically on the field primitive; per-form instruction copy " +
      "is a manual content check.",
  },
  "4.1.3": {
    check:
      "the toast viewport exposes assertive role=alert for errors and polite " +
      "role=status otherwise (a11yStructural.test.tsx)",
    remark:
      "Status changes are announced through a live region: error toasts render " +
      "as assertive role=alert and all other tones as polite role=status, so " +
      "assistive tech announces them without moving focus. " +
      "Verified automatically on the toast surface (structure only; timing and " +
      "visibility are not machine-checked).",
  },
  "2.5.8": {
    check:
      "shared Button sizes + an icon-only Button measure >= 24x24 CSS px in real " +
      "Chromium (targetSize.browser.test.tsx)",
    browserBacked: true,
    remark:
      "Interactive targets meet the 24x24 CSS px minimum: the shared Button " +
      "primitive's action sizes (including xs) and icon-only shape are measured " +
      "in a real browser layout engine — " +
      BROWSER_CI_DISCLOSURE +
      ". An exhaustive per-site target sweep is a manual follow-up.",
  },
  "1.4.10": {
    check:
      "a representative Card layout has no element wider than a 320px viewport in " +
      "real Chromium (reflow.browser.test.tsx)",
    browserBacked: true,
    remark:
      "Content reflows without horizontal scroll: a representative layout of the " +
      "shared Card/Button primitives is measured at a 320px viewport in a real " +
      "browser and no element exceeds the width — " +
      BROWSER_CI_DISCLOSURE +
      ". A per-route reflow sweep is a manual follow-up.",
  },
  "1.4.4": {
    check:
      "enlarging the root font to 200% scales text (relative units) and the " +
      "sample still fits the viewport in real Chromium (resizeText.browser.test.tsx)",
    browserBacked: true,
    remark:
      "Text resizes to 200% without loss of content: with the root font enlarged " +
      "to 200% in a real browser, the shared primitives' text scales (relative " +
      "units) and the layout still fits without clipping or horizontal overflow — " +
      BROWSER_CI_DISCLOSURE +
      ". A per-route zoom sweep is a manual follow-up.",
  },
  "1.4.12": {
    check:
      "the WCAG text-spacing overrides (line-height 1.5, letter 0.12em, word " +
      "0.16em, paragraph 2em) apply without clipping in real Chromium " +
      "(textSpacing.browser.test.tsx)",
    browserBacked: true,
    remark:
      "Content survives the WCAG 1.4.12 text-spacing overrides (line-height 1.5x, " +
      "letter-spacing 0.12em, word-spacing 0.16em, paragraph spacing 2em): applied " +
      "to the shared primitives in a real browser, the container grows to fit " +
      "rather than clipping — " +
      BROWSER_CI_DISCLOSURE +
      ". A per-route sweep is a manual follow-up.",
  },
}
