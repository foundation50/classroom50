import { describe, expect, it } from "vitest"

import {
  contrastRatio,
  flattenOver,
  mixColor,
  parseColor,
  ratioOver,
  toHex,
} from "./contrast"

// These pins validate the color-space math against independently known values
// so the guard (contrastGuard.test.ts) can trust the resolver. WCAG examples
// and browser-computed color-mix results are the ground truth here — this is
// the "pin against real values once" cross-check the plan calls for, expressed
// as fixtures rather than a live browser (vitest runs headless in node).

describe("contrastRatio — WCAG reference pairs", () => {
  it("black on white is 21:1", () => {
    expect(
      contrastRatio(parseColor("#000000"), parseColor("#ffffff")),
    ).toBeCloseTo(21, 2)
  })

  it("white on white is 1:1", () => {
    expect(
      contrastRatio(parseColor("#ffffff"), parseColor("#ffffff")),
    ).toBeCloseTo(1, 5)
  })

  it("sumi ink #232323 on base #fafafa is ~14.9:1 (a known AAA pass)", () => {
    // Cross-checked against WebAIM's contrast checker.
    const r = contrastRatio(parseColor("#232323"), parseColor("#fafafa"))
    expect(r).toBeGreaterThan(14.5)
    expect(r).toBeLessThan(15.2)
  })

  it("mid-grey #767676 on white is ~4.54:1 (the classic AA boundary)", () => {
    const r = contrastRatio(parseColor("#767676"), parseColor("#ffffff"))
    expect(r).toBeCloseTo(4.54, 1)
  })
})

describe("hex parsing", () => {
  it("expands #rgb shorthand", () => {
    expect(toHex(parseColor("#fff"))).toBe("#ffffff")
    expect(toHex(parseColor("#abc"))).toBe("#aabbcc")
  })

  it("round-trips a 6-digit hex through linear sRGB", () => {
    expect(toHex(parseColor("#3e5da8"))).toBe("#3e5da8")
  })
})

describe("oklch/oklab parsing", () => {
  it("parses oklch and converts to a plausible sRGB hex", () => {
    // oklch(0.7 0.15 250) is a mid indigo; assert it lands in the blue family.
    const c = parseColor("oklch(0.7 0.15 250)")
    expect(c.b).toBeGreaterThan(c.r) // blue-dominant
  })

  it("pure-white oklch(1 0 0) is #ffffff", () => {
    expect(toHex(parseColor("oklch(1 0 0)"))).toBe("#ffffff")
  })
})

describe("color-mix — validated against browser-computed values", () => {
  // The .label override: color-mix(in oklab, #232323 70%, transparent) on #fafafa.
  // Gamma-space composite: 0x23*0.7 + 0xfa*0.3 ~= 99.5 => ~#636363, ~5.9:1.
  it("70% base-content over transparent, flattened on base-100", () => {
    const label = mixColor("oklab", "#232323", 70, "transparent")
    const r = ratioOver(label, parseColor("#fafafa"))
    // Browser + WebAIM cross-check: ~5.9:1 (comfortably AA, just under AAA 7:1).
    expect(r).toBeGreaterThan(5.5)
    expect(r).toBeLessThan(6.3)
  })

  it("50% opacity black over white halves toward mid-grey", () => {
    // color-mix(in srgb, black 50%, transparent) flattened on white ~= #808080.
    const half = mixColor("srgb", "#000000", 50, "transparent")
    expect(half.a).toBeCloseTo(0.5, 5)
    const flat = ratioSurface(half)
    // ~127.5/255 per channel; allow the ±1 LSB the linear round-trip can drift.
    const channel = Math.round(
      (flat.r <= 0.0031308
        ? flat.r * 12.92
        : 1.055 * flat.r ** (1 / 2.4) - 0.055) * 255,
    )
    expect(channel).toBeGreaterThanOrEqual(127)
    expect(channel).toBeLessThanOrEqual(128)
  })

  it("mixing a token with black darkens it (badge-soft nudge shape)", () => {
    // color-mix(in oklab, <token> 88%, black): the light-theme badge nudge.
    const nudged = mixColor("oklab", "#5a5a5a", 88, "black")
    const original = parseColor("#5a5a5a")
    // Darker => lower luminance.
    expect(nudged.r + nudged.g + nudged.b).toBeLessThan(
      original.r + original.g + original.b,
    )
  })

  it("pins the chromatic oklab mix path used by soft badges", () => {
    // The badge-soft foreground mixes a genuinely chromatic token in oklab
    // (mixColor("oklab", "#3e5da8", 65, "black")). Unlike the achromatic cases
    // above, this exercises the a/b (hue/chroma) channels and the
    // linearRgbToOklab -> oklabToLinearRgb round trip. Pinned to the resolved
    // sRGB hex, cross-checkable against a browser's
    // `color-mix(in oklab, #3e5da8 65%, black)`; a hue/chroma regression in the
    // OKLab matrices would move this value and fail here rather than silently
    // shifting a badge ratio.
    expect(toHex(mixColor("oklab", "#3e5da8", 65, "black"))).toBe("#1e305c")
    expect(toHex(mixColor("oklab", "#c04a2b", 65, "black"))).toBe("#6a2513")
    // A pure oklch->sRGB conversion pinned to a known hex.
    expect(toHex(parseColor("oklch(0.7 0.15 250)"))).toBe("#4ba3f7")
  })
})

// Local helper mirroring ratioOver's flatten step (gamma-space composite) for
// the mid-grey assertion.
function ratioSurface(fg: ReturnType<typeof mixColor>) {
  return flattenOver(fg, parseColor("#ffffff"))
}
