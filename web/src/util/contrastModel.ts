// The color model the audit report and the regression guard both consume.
//
// Per KTD5, the audit unit is a resolved (foreground, surface, size-class)
// triple, not a token — text size and the surface a `/NN` foreground flattens
// against are per-site Tailwind facts. This module enumerates the DISTINCT
// triples the sumi themes actually produce (the unique combinations that decide
// pass/fail), grounded in the usage scan of src/**. A pair present in JSX but
// absent here is an audit gap the guard cannot cover; add it when introduced.
//
// Foregrounds are expressed exactly as the CSS produces them (a hex token, an
// opacity `mix(... transparent)`, or the per-theme badge/label overrides) so
// the resolver (contrast.ts) reproduces the rendered pixel rather than an
// approximation. Keep this a pure leaf: data + types only, no app imports.

import { mixColor, parseColor, ratioOver, type LinearRgb } from "./contrast"

export type SizeClass = "body" | "large"
export type Theme = "sumi" | "sumi-dark"

/** WCAG 1.4.6 (AAA text) / 1.4.11 (non-text) spec floors. */
export const SPEC_FLOOR = { body: 7, large: 4.5, nonText: 3 } as const
/** Design-target margins (reported, non-blocking per the guard-strictness decision). */
export const MARGIN_TARGET = { body: 7.5, large: 5, nonText: 3.5 } as const

export type Kind = "text" | "nonText"

export type Pair = {
  /** Stable id for reporting. */
  id: string
  theme: Theme
  /** Human label for the audit report. */
  label: string
  /** Foreground as rendered (opaque or translucent linear sRGB). */
  fg: LinearRgb
  /** Opaque surface the foreground is composited over. */
  bg: LinearRgb
  size: SizeClass
  kind: Kind
  /** True for logotypes / disabled / decorative — exempt from WCAG. */
  exempt?: boolean
}

// ── Raw theme token values (mirrors index.css; single source for the audit) ──
// Light theme "sumi". (base-content darkened to #1a1a1a and warning darkened
// for text/fill per the AAA override block in index.css.)
const SUMI = {
  base100: "#fafafa",
  base200: "#f1f1f1",
  base300: "#e3e3e3",
  baseContent: "#1a1a1a",
  primary: "#3e5da8",
  primaryContent: "#fafafa",
  secondary: "#5a5a5a",
  secondaryContent: "#fafafa",
  accent: "#c04a2b",
  accentContent: "#fafafa",
  neutral: "#232323",
  neutralContent: "#f1f1f1",
  info: "#2f7d8a",
  infoContent: "#fafafa",
  success: "#3f7d54",
  successContent: "#fafafa",
  // AAA override: warning darkened for text use AND fill (white label >=4.5).
  warningText: "#7a5012",
  warningFill: "#7a5012",
  warningContent: "#fafafa",
  error: "#b0392f",
  errorContent: "#fafafa",
  // Sidebar: opaque charcoal panel over the light canvas.
  sidebarSurface: "#3a3a3a",
  // Per-theme link color and muted-tier opacity floors (index.css overrides).
  link: "#324d8c",
  muted: { 50: 78, 60: 82, 70: 86, 80: 90 } as Record<number, number>,
  badgeNudge: 65,
  sidebarMuted: 85,
} as const

// Dark theme "sumi-dark".
const DARK = {
  base100: "#1b1b1d",
  base200: "#161618",
  base300: "#100f11",
  baseContent: "#ececee",
  primary: "#8ba3d4",
  primaryContent: "#14181c",
  secondary: "#a8a8ac",
  secondaryContent: "#14181c",
  accent: "#e08a6f",
  accentContent: "#14181c",
  neutral: "#26262a",
  neutralContent: "#ececee",
  info: "#6fb8c4",
  infoContent: "#14181c",
  success: "#8fb89f",
  successContent: "#14181c",
  warning: "#d0ad6e",
  warningContent: "#14181c",
  error: "#d08a82",
  errorContent: "#14181c",
  // Per-theme link color and muted-tier opacity floors (index.css overrides).
  link: "#9bb0dc",
  muted: { 50: 68, 60: 74, 70: 80, 80: 86 } as Record<number, number>,
  badgeNudge: 60,
  sidebarMuted: 85,
} as const

// The dark sidebar surface is a translucent sheet over base-100, NOT #3a3a3a.
// --sidebar-surface: color-mix(in oklch, neutral-content 10%, transparent)
function darkSidebarSurface(): LinearRgb {
  const sheet = mixColor("oklch", DARK.neutralContent, 10, "transparent")
  // Flatten the translucent sheet over the dark base to get its real color.
  const base = parseColor(DARK.base100)
  return {
    ...mixColorFlatten(sheet, base),
  }
}

// Flatten helper (gamma-space composite lives in contrast.ts via ratioOver's
// internal flatten; expose the same for a precomputed opaque surface).
function mixColorFlatten(fg: LinearRgb, bg: LinearRgb): LinearRgb {
  // Reuse ratioOver's flatten indirectly by compositing here in gamma space.
  const toG = (l: number) =>
    l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055
  const toL = (s: number) =>
    s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  const a = fg.a
  const blend = (fl: number, bl: number) =>
    toL(toG(fl) * a + toG(bl) * (1 - a))
  return { r: blend(fg.r, bg.r), g: blend(fg.g, bg.g), b: blend(fg.b, bg.b), a: 1 }
}

// Opacity-tier foreground: color a token at NN% over transparent (what
// `text-<token>/NN` renders), left translucent so ratioOver flattens it.
const tierFg = (token: string, pct: number): LinearRgb =>
  mixColor("srgb", token, pct, "transparent")

// The per-theme .badge-soft nudge applied to a semantic token used as soft-badge
// text: light darkens toward black; dark lightens toward white (index.css).
const badgeSoftFg = (theme: Theme, token: string): LinearRgb =>
  theme === "sumi"
    ? mixColor("oklab", token, SUMI.badgeNudge, "black")
    : mixColor("oklab", token, DARK.badgeNudge, "white")

// A soft badge/alert ground: an 8% tint of the token over the base surface.
const softGround = (token: string, base: string): LinearRgb =>
  mixColorFlatten(mixColor("srgb", token, 8, "transparent"), parseColor(base))

function buildTheme(theme: Theme): Pair[] {
  const T = theme === "sumi" ? SUMI : DARK
  const opaque = (hex: string) => parseColor(hex)
  const pairs: Pair[] = []
  const add = (
    id: string,
    label: string,
    fg: LinearRgb,
    bg: LinearRgb,
    size: SizeClass,
    kind: Kind = "text",
    exempt = false,
  ) => pairs.push({ id: `${theme}:${id}`, theme, label, fg, bg, size, kind, exempt })

  // Body ink on each surface a page realistically uses.
  add("ink-100", "base-content on base-100", opaque(T.baseContent), opaque(T.base100), "body")
  add("ink-200", "base-content on base-200", opaque(T.baseContent), opaque(T.base200), "body")
  add("ink-300", "base-content on base-300", opaque(T.baseContent), opaque(T.base300), "body")

  // Muted text tiers, at their AAA-remapped opacity floors (index.css). Audited
  // against the realistic worst-case surface for the foreground's polarity:
  // dark ink on the DARKEST surface (base-300) is the lowest-contrast case in
  // light theme; light ink's worst case in dark theme is the lightest surface
  // (base-100).
  const tierWorstBg =
    theme === "sumi" ? opaque(T.base300) : opaque(T.base100)
  for (const pct of [50, 60, 70, 80] as const) {
    add(
      `muted-${pct}`,
      `base-content/${pct} (rendered ${T.muted[pct]}%) on worst-case surface`,
      tierFg(T.baseContent, T.muted[pct]),
      tierWorstBg,
      "body",
    )
  }

  // Button fills: light content label on the solid semantic fill.
  const fills: [string, string, string][] = [
    ["primary", T.primary, T.primaryContent],
    ["secondary", T.secondary, T.secondaryContent],
    ["accent", T.accent, T.accentContent],
    ["info", T.info, T.infoContent],
    ["success", T.success, T.successContent],
    ["error", T.error, T.errorContent],
    [
      "warning",
      theme === "sumi" ? SUMI.warningFill : DARK.warning,
      theme === "sumi" ? SUMI.warningContent : DARK.warningContent,
    ],
  ]
  for (const [name, fill, content] of fills) {
    add(`fill-${name}`, `${name}-content on ${name} fill`, opaque(content), opaque(fill), "large")
  }

  // Soft badge text: nudged token on an 8% tint of the token over base-100.
  const semantics: [string, string][] = [
    ["primary", T.primary],
    ["secondary", T.secondary],
    ["info", T.info],
    ["success", T.success],
    // warning soft text uses the darkened warningText (light) / warning (dark).
    ["warning", theme === "sumi" ? SUMI.warningText : DARK.warning],
    ["error", T.error],
  ]
  for (const [name, token] of semantics) {
    add(
      `badge-${name}`,
      `${name} soft-badge text`,
      badgeSoftFg(theme, token),
      softGround(token, T.base100),
      "body",
    )
  }

  // Link text (daisyUI .link / hover:text-primary) uses the per-theme link
  // color on base-100, body size (index.css --color-link override).
  add("link", "link on base-100", opaque(T.link), opaque(T.base100), "body")

  // Sidebar (dark rail in both themes). Resting muted row is neutral-content at
  // the AAA-raised opacity; hover lifts to full neutral-content.
  const sidebarSurface =
    theme === "sumi" ? opaque(SUMI.sidebarSurface) : darkSidebarSurface()
  add(
    "sidebar-muted",
    `neutral-content/${T.sidebarMuted} (resting) on sidebar surface`,
    tierFg(T.neutralContent, T.sidebarMuted),
    sidebarSurface,
    "body",
  )
  add(
    "sidebar-hover",
    "neutral-content (hover) on sidebar surface",
    opaque(T.neutralContent),
    sidebarSurface,
    "body",
  )

  // Placeholder and .label both render at the muted-70 floor (index.css).
  add("placeholder", "input placeholder", tierFg(T.baseContent, T.muted[70]), opaque(T.base100), "body")
  add("label", ".label text", tierFg(T.baseContent, T.muted[70]), opaque(T.base100), "body")

  // Non-text: the default divider/border (base-300) on base-100 is structural,
  // NOT the sole means of identifying a control, so it's outside 1.4.11's scope
  // (which governs information "required to identify" a component/state). Marked
  // exempt so the guard doesn't force a heavy 3:1 divider that would break the
  // minimalist aesthetic. Focus rings / active-state borders (which DO identify
  // state) are the primary/accent tokens, audited via the fill/link pairs.
  add("border", "base-300 structural divider on base-100", opaque(T.base300), opaque(T.base100), "body", "nonText", true)

  return pairs
}

export const PAIRS: Pair[] = [...buildTheme("sumi"), ...buildTheme("sumi-dark")]

export type Evaluated = Pair & {
  ratio: number
  floor: number
  margin: number
  passesFloor: boolean
  passesMargin: boolean
}

/** Evaluate one pair against its spec floor and design margin. */
export function evaluate(p: Pair): Evaluated {
  const ratio = ratioOver(p.fg, p.bg)
  const floor = p.kind === "nonText" ? SPEC_FLOOR.nonText : SPEC_FLOOR[p.size]
  const margin =
    p.kind === "nonText" ? MARGIN_TARGET.nonText : MARGIN_TARGET[p.size]
  return {
    ...p,
    ratio,
    floor,
    margin,
    passesFloor: p.exempt || ratio >= floor,
    passesMargin: p.exempt || ratio >= margin,
  }
}

export const evaluateAll = (): Evaluated[] => PAIRS.map(evaluate)
