// Pure, DOM-free predicates for the machine-checkable structural WCAG facts
// (plan -004- U2). Inputs are already-extracted data (heading levels, a lang
// string, a size), so these stay a util/ leaf and unit-test directly. The
// render-based checks that actually walk a mounted DOM live in
// src/test/a11yStructural.test.tsx and feed these predicates.

/** WCAG 2.5.8 Target Size (Minimum): interactive targets are >= 24x24 CSS px. */
export const TARGET_SIZE_MIN = 24

/** True when the page has exactly one <h1> (2.4.6 / document outline). */
export function hasSingleH1(headingLevels: number[]): boolean {
  return headingLevels.filter((l) => l === 1).length === 1
}

/**
 * True when heading levels never jump deeper by more than one at a time
 * (a well-formed outline; supports 1.3.1). An empty list is vacuously true.
 *
 * Staged for the heading-remediation unit (umbrella U7): not yet bound to a
 * criterion in AUTOMATED_CRITERIA — it becomes the check behind 1.3.1 / 2.4.6
 * once the heading structure across the app's views is clean.
 */
export function hasNoSkippedHeadingLevels(headingLevels: number[]): boolean {
  let prev = 0
  for (const level of headingLevels) {
    if (prev !== 0 && level > prev + 1) return false
    prev = level
  }
  return true
}

/** True when the document carries a non-empty `lang` (3.1.1 Language of Page). */
export function documentHasLang(langAttr: string | null | undefined): boolean {
  return typeof langAttr === "string" && langAttr.trim().length > 0
}

/** True when a target meets the 24x24 CSS px minimum (2.5.8). */
export function meetsTargetSize(width: number, height: number): boolean {
  return width >= TARGET_SIZE_MIN && height >= TARGET_SIZE_MIN
}
