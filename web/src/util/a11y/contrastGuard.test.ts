import { describe, expect, it } from "vitest"

import { evaluateAll, type Evaluated } from "./contrastModel"

// The WCAG 2.2 contrast regression guard. Runs in `npm run check`.
//
// Enforcement strictness (a deliberate decision): the guard HARD-FAILS at the
// WCAG spec floor — 4.5:1 body text and 3:1 large text (1.4.3 AA), 3:1 non-text
// (1.4.11) — so any future palette edit that drops a real pair below the standard
// breaks CI. AA is the enforced target because the palette is GitHub Primer
// verbatim and Primer's primitives are tuned to AA; the stricter 1.4.6 (AAA)
// floors are still scored per pair and reported (the VPAT's 1.4.6 row derives
// from that tally), just never enforced. The extra design-safety margin (5 / 3.5)
// is likewise REPORTED but NON-BLOCKING, so a spec-compliant brand tweak that
// dips into the margin band doesn't fail the build. Exempt pairs (logotypes,
// disabled/inactive controls, structural dividers outside 1.4.11's "required to
// identify" scope) are skipped.
//
// This is a hermetic computation (no browser); its color-space + alpha math is
// pinned against known/browser-computed values in contrast.test.ts.

const evaluated = evaluateAll()

describe("WCAG 2.2 contrast guard — spec floor (blocking)", () => {
  const enforced = evaluated.filter((p) => !p.exempt)

  // Floor: a bug that empties PAIRS or tags everything exempt would make the
  // it.each below register zero cases and pass silently. Fail loudly instead.
  it("enforces a non-empty set of pairs in both themes", () => {
    expect(enforced.length).toBeGreaterThanOrEqual(20)
    expect(enforced.some((p) => p.theme === "sumi")).toBe(true)
    expect(enforced.some((p) => p.theme === "sumi-dark")).toBe(true)
  })

  it.each(enforced)("$id meets its spec floor ($label)", (p: Evaluated) => {
    expect(
      p.ratio,
      `${p.id} (${p.label}): ${p.ratio.toFixed(2)}:1 is below the WCAG floor of ${p.floor}:1`,
    ).toBeGreaterThanOrEqual(p.floor)
  })
})

describe("WCAG 2.2 contrast guard — coverage", () => {
  it("evaluates both themes and every enforced pair has a positive ratio", () => {
    expect(evaluated.some((p) => p.theme === "sumi")).toBe(true)
    expect(evaluated.some((p) => p.theme === "sumi-dark")).toBe(true)
    for (const p of evaluated) expect(p.ratio).toBeGreaterThan(0)
  })

  it("reports margin misses without failing (design-target, non-blocking)", () => {
    const misses = evaluated.filter(
      (p) => !p.exempt && p.passesFloor && !p.passesMargin,
    )
    if (misses.length > 0) {
      const lines = misses
        .map(
          (p) =>
            `  ${p.id}: ${p.ratio.toFixed(2)}:1 (floor ${p.floor} met, margin ${p.margin} missed) — ${p.label}`,
        )
        .join("\n")
      // eslint-disable-next-line no-console
      console.warn(
        `\n[contrast] ${misses.length} pair(s) clear the WCAG floor but miss the design margin:\n${lines}\n`,
      )
    }
    // Exercise the passesFloor/passesMargin derivation (not the filter predicate):
    // every margin-miss must sit in the band [floor, margin). The margin itself
    // is aspirational and intentionally not enforced as a failure.
    for (const p of misses) {
      expect(p.ratio).toBeGreaterThanOrEqual(p.floor)
      expect(p.ratio).toBeLessThan(p.margin)
    }
  })
})
