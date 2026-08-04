// WCAG contrast math for the theme audit and its regression guard.
//
// WCAG relative luminance (and thus the contrast ratio) is defined only on
// sRGB. The sumi themes, however, express several colors in oklab/oklch via
// CSS `color-mix(...)` (the placeholder/.label/badge-soft overrides, the dark
// sidebar surface). vitest runs under `environment: "node"` with no CSS engine,
// so `getComputedStyle` cannot resolve those mixes — this module does the
// color-space + alpha math itself: parse -> convert to linear sRGB -> flatten
// any alpha over a known backdrop -> WCAG luminance -> ratio. Keep it a pure
// leaf (no app imports) so it satisfies the util/ leaf boundary.

/** Linear-light sRGB, each channel in [0,1]. Alpha in [0,1]; 1 = opaque. */
export type LinearRgb = { r: number; g: number; b: number; a: number }

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

// ── sRGB gamma <-> linear ────────────────────────────────────────────────
// Standard sRGB transfer function (IEC 61966-2-1).
function srgbToLinearChannel(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
function linearToSrgbChannel(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

// ── oklab/oklch -> linear sRGB ─────────────────────────────────────────────
// Björn Ottosson's OKLab. oklch is oklab in polar form (L, C, hue°).
function oklabToLinearRgb(L: number, a: number, b: number): {
  r: number
  g: number
  bl: number
} {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b

  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_

  return {
    r: +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    bl: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  }
}

function oklchToLinearRgb(L: number, C: number, hDeg: number): {
  r: number
  g: number
  bl: number
} {
  const h = (hDeg * Math.PI) / 180
  return oklabToLinearRgb(L, C * Math.cos(h), C * Math.sin(h))
}

// ── Parsing ────────────────────────────────────────────────────────────────
// Supports the subset the sumi themes actually use: #rgb / #rrggbb hex,
// oklch()/oklab(), and the `transparent` keyword. Percentages and unit-less
// forms both accepted for L/C where the spec allows them.

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i

function num(token: string): number {
  // "62%" -> 0.62 ; "0.62" -> 0.62 ; "120" (hue) -> 120
  const t = token.trim()
  if (t.endsWith("%")) return parseFloat(t) / 100
  return parseFloat(t)
}

/** Parse a supported CSS color into linear sRGB with straight alpha. */
export function parseColor(input: string): LinearRgb {
  const s = input.trim().toLowerCase()

  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 }

  const h6 = HEX6.exec(s)
  if (h6) {
    return {
      r: srgbToLinearChannel(parseInt(h6[1], 16) / 255),
      g: srgbToLinearChannel(parseInt(h6[2], 16) / 255),
      b: srgbToLinearChannel(parseInt(h6[3], 16) / 255),
      a: 1,
    }
  }
  const h3 = HEX3.exec(s)
  if (h3) {
    const dup = (c: string) => parseInt(c + c, 16) / 255
    return {
      r: srgbToLinearChannel(dup(h3[1])),
      g: srgbToLinearChannel(dup(h3[2])),
      b: srgbToLinearChannel(dup(h3[3])),
      a: 1,
    }
  }

  const fn = /^(oklch|oklab)\(([^)]*)\)$/.exec(s)
  if (fn) {
    const kind = fn[1]
    // Split components by whitespace, and an optional `/ alpha` tail.
    const [coords, alphaPart] = fn[2].split("/")
    const parts = coords.trim().split(/\s+/).filter(Boolean)
    const a = alphaPart !== undefined ? num(alphaPart) : 1
    if (kind === "oklch") {
      const [L, C, h] = parts
      const { r, g, bl } = oklchToLinearRgb(num(L), num(C), parseFloat(h))
      return { r, g, b: bl, a }
    }
    // oklab
    const [L, aa, bb] = parts
    const { r, g, bl } = oklabToLinearRgb(num(L), num(aa), num(bb))
    return { r, g, b: bl, a }
  }

  throw new Error(`Unsupported color syntax: ${input}`)
}

// ── color-mix(in <space>, colorA pctA, colorB pctB) ─────────────────────────
// Mirrors CSS color-mix: percentages are normalized, and when they don't sum
// to 100% the result is scaled (the CSS "alpha multiplier" behaviour). The
// sumi overrides all mix a token with `black`/`white`/`transparent`, and mix
// in oklab or oklch — so mixing happens in the mix color-space, then converts
// to linear sRGB. Alpha is interpolated linearly.
export function mixColor(
  space: "oklab" | "oklch" | "srgb",
  colorA: string,
  pctA: number,
  colorB: string,
  pctB = 100 - pctA,
): LinearRgb {
  // Named endpoints CSS understands that our parser doesn't need generally.
  const named: Record<string, string> = {
    black: "#000000",
    white: "#ffffff",
    transparent: "transparent",
  }
  const resolveEndpoint = (c: string) => named[c.trim().toLowerCase()] ?? c

  const a = parseColor(resolveEndpoint(colorA))
  const b = parseColor(resolveEndpoint(colorB))

  // Normalize weights per CSS: if the sum p != 100, weights scale by p/100 and
  // the alpha of the result is multiplied by p/100.
  const pa = pctA / 100
  const pb = pctB / 100
  const sum = pa + pb || 1
  const wa = pa / sum
  const wb = pb / sum
  const alphaMultiplier = Math.min(1, sum)

  // Premultiply by alpha for the mix, per CSS color-mix, then un-premultiply.
  const mixedAlpha = wa * a.a + wb * b.a
  const lerp = (ca: number, cb: number) =>
    mixedAlpha === 0 ? 0 : (wa * a.a * ca + wb * b.a * cb) / mixedAlpha

  if (space === "srgb") {
    return {
      r: lerp(a.r, b.r),
      g: lerp(a.g, b.g),
      b: lerp(a.b, b.b),
      a: mixedAlpha * alphaMultiplier,
    }
  }

  // Mix in oklab/oklch: convert both endpoints to that space, interpolate,
  // convert back. We only ever need the oklab path numerically — oklch mixes
  // of our tokens (a color mixed with an achromatic black/white/transparent)
  // give the same result mixed in oklab because the chromatic endpoint's hue
  // is preserved when the other endpoint has zero chroma. Interpolating in
  // oklab is therefore exact for our inputs and avoids hue-wraparound edge
  // cases; documented so a future non-achromatic oklch mix is added knowingly.
  const toOklab = (lin: LinearRgb) => linearRgbToOklab(lin)
  const oa = toOklab(a)
  const ob = toOklab(b)
  const mixedL = lerp(oa.L, ob.L)
  const mixedA = lerp(oa.a, ob.a)
  const mixedB = lerp(oa.b, ob.b)
  const { r, g, bl } = oklabToLinearRgb(mixedL, mixedA, mixedB)
  return { r, g, b: bl, a: mixedAlpha * alphaMultiplier }
}

// linear sRGB -> oklab (inverse of oklabToLinearRgb), for mixing in oklab.
function linearRgbToOklab(c: LinearRgb): { L: number; a: number; b: number } {
  const l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b
  const m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b
  const s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b
  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  }
}

// ── Alpha flatten + luminance + ratio ────────────────────────────────────────

/** Composite a (possibly translucent) foreground over an opaque backdrop.
 *  CSS alpha compositing happens on gamma-encoded sRGB channels (a `/NN`
 *  opacity or `color-mix(... transparent)` blends the displayed, gamma values),
 *  so convert to gamma, blend, and convert back to linear for luminance. */
export function flattenOver(fg: LinearRgb, backdrop: LinearRgb): LinearRgb {
  const a = clamp01(fg.a)
  const blend = (fgLin: number, bgLin: number) => {
    const fgG = linearToSrgbChannel(clamp01(fgLin))
    const bgG = linearToSrgbChannel(clamp01(bgLin))
    return srgbToLinearChannel(fgG * a + bgG * (1 - a))
  }
  return {
    r: blend(fg.r, backdrop.r),
    g: blend(fg.g, backdrop.g),
    b: blend(fg.b, backdrop.b),
    a: 1,
  }
}

/** WCAG relative luminance from linear sRGB (assumes opaque). */
export function relativeLuminance(c: LinearRgb): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
}

/** WCAG contrast ratio between two opaque linear-sRGB colors. */
export function contrastRatio(fg: LinearRgb, bg: LinearRgb): number {
  const l1 = relativeLuminance(fg)
  const l2 = relativeLuminance(bg)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Contrast ratio of a foreground (which may be translucent) over a background.
 * The background is assumed opaque; a translucent fg is flattened over it first
 * — exactly what a `/NN` opacity utility or `color-mix(... transparent)` does.
 */
export function ratioOver(fg: LinearRgb, bg: LinearRgb): number {
  const opaqueBg = bg.a < 1 ? flattenOver(bg, parseColor("#ffffff")) : bg
  return contrastRatio(flattenOver(fg, opaqueBg), opaqueBg)
}

/** Convenience: opaque linear-sRGB back to an sRGB hex string (for debugging). */
export function toHex(c: LinearRgb): string {
  const ch = (x: number) =>
    Math.round(clamp01(linearToSrgbChannel(clamp01(x))) * 255)
      .toString(16)
      .padStart(2, "0")
  return `#${ch(c.r)}${ch(c.g)}${ch(c.b)}`
}
