// The color model the audit report and the regression guard both consume.
//
// Per KTD5, the audit unit is a resolved (foreground, surface, size-class)
// triple, not a token — text size and the surface a `/NN` foreground sits on
// are per-site Tailwind facts. This enumerates the distinct triples the themes
// produce; a pair used in JSX but absent here is an audit gap (the coverage
// guard in contrastSource.test.ts enforces against it). Foregrounds are
// expressed as the CSS produces them so contrast.ts resolves the real pixel.
// Pure leaf: data + types only, no app imports.

import {
  flattenOver,
  mixColor,
  parseColor,
  ratioOver,
  toHex,
  type LinearRgb,
} from "./contrast"

export type SizeClass = "body" | "large"
export type Theme = "sumi" | "sumi-dark"

/** WCAG 1.4.6 (AAA text) / 1.4.11 (non-text) spec floors. */
export const SPEC_FLOOR = { body: 7, large: 4.5, nonText: 3 } as const
/** Design-target margins (reported, non-blocking per the guard-strictness decision). */
export const MARGIN_TARGET = { body: 7.5, large: 5, nonText: 3.5 } as const

export type Kind = "text" | "nonText"

// Which `text-base-content/NN` and `text-neutral-content/NN` opacity tiers the
// model audits. The coverage guard (contrastSource.test.ts) scans src/** and
// fails if a tier used on text is missing here — turning the "a pair present in
// JSX but absent here is an audit gap" comment into an enforced check.
export const MODELED_BASE_CONTENT_TIERS = [30, 40, 50, 60, 70, 80, 90] as const
export const MODELED_NEUTRAL_CONTENT_TIERS = [50, 60, 70] as const

// Semantic text tokens modeled as body text on a base surface (the `text-<name>`
// pairs built in buildTheme). The coverage guard (contrastSource.test.ts) scans
// src/** for `text-<name>` utilities and fails if a used one is absent here, so
// a new low-contrast semantic text color can't ship while the audit stays green.
export const MODELED_TEXT_SEMANTICS = [
  "primary",
  "secondary",
  "accent",
  "info",
  "success",
  "error",
  "warning",
] as const

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

// Raw theme token values. These duplicate the index.css tokens (node has no CSS
// engine to read them); the drift guard in contrastSource.test.ts asserts they
// stay in sync, so the copy can't silently diverge.
// Light theme "sumi" (base-content and warning darkened per the AAA overrides).
export const SUMI = {
  base100: "#fafafa",
  base200: "#f1f1f1",
  base300: "#e3e3e3",
  baseContent: "#1a1a1a",
  primary: "#375396",
  primaryContent: "#fafafa",
  secondary: "#565656",
  secondaryContent: "#fafafa",
  accent: "#923821",
  accentContent: "#fafafa",
  neutral: "#232323",
  neutralContent: "#f1f1f1",
  info: "#235c66",
  infoContent: "#fafafa",
  success: "#305f40",
  successContent: "#fafafa",
  // AAA override: warning darkened for text use AND fill (white label >=4.5).
  warningText: "#754d11",
  warningFill: "#754d11",
  warningContent: "#fafafa",
  error: "#993229",
  errorContent: "#fafafa",
  // Sidebar: opaque charcoal panel over the light canvas.
  sidebarSurface: "#3a3a3a",
  // Per-theme link color and muted-tier opacity floors (index.css overrides).
  link: "#324d8c",
  muted: { 30: 78, 40: 78, 50: 78, 60: 82, 70: 86, 80: 90, 90: 92 } as Record<
    number,
    number
  >,
  badgeNudge: 65,
  sidebarMuted: 85,
} as const

// Dark theme "sumi-dark". Exported for the drift guard (see SUMI).
export const DARK = {
  base100: "#1b1b1d",
  base200: "#161618",
  base300: "#100f11",
  baseContent: "#ececee",
  primary: "#90a7d6",
  primaryContent: "#14181c",
  secondary: "#a8a8ac",
  secondaryContent: "#14181c",
  accent: "#e29279",
  accentContent: "#14181c",
  neutral: "#26262a",
  neutralContent: "#ececee",
  info: "#6fb8c4",
  infoContent: "#14181c",
  success: "#8fb89f",
  successContent: "#14181c",
  warning: "#d0ad6e",
  warningContent: "#14181c",
  error: "#d5968f",
  errorContent: "#14181c",
  // Per-theme link color and muted-tier opacity floors (index.css overrides).
  link: "#9bb0dc",
  muted: { 30: 68, 40: 68, 50: 68, 60: 74, 70: 80, 80: 86, 90: 92 } as Record<
    number,
    number
  >,
  badgeNudge: 60,
  sidebarMuted: 85,
} as const

// The dark sidebar surface is a translucent sheet over base-100, NOT #3a3a3a.
// --sidebar-surface: color-mix(in oklch, neutral-content 10%, transparent)
function darkSidebarSurface(): LinearRgb {
  const sheet = mixColor("oklch", DARK.neutralContent, 10, "transparent")
  // Flatten the translucent sheet over the dark base to get its real color.
  return flattenOver(sheet, parseColor(DARK.base100))
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
  flattenOver(mixColor("srgb", token, 8, "transparent"), parseColor(base))

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
  ) =>
    pairs.push({
      id: `${theme}:${id}`,
      theme,
      label,
      fg,
      bg,
      size,
      kind,
      exempt,
    })

  // Body ink on each surface a page realistically uses.
  add(
    "ink-100",
    "base-content on base-100",
    opaque(T.baseContent),
    opaque(T.base100),
    "body",
  )
  add(
    "ink-200",
    "base-content on base-200",
    opaque(T.baseContent),
    opaque(T.base200),
    "body",
  )
  add(
    "ink-300",
    "base-content on base-300",
    opaque(T.baseContent),
    opaque(T.base300),
    "body",
  )

  // Muted tiers at their AAA-remapped opacities (index.css), audited against the
  // worst-case surface for the ink polarity: darkest surface (base-300) in light,
  // lightest (base-100) in dark.
  const tierWorstBg = theme === "sumi" ? opaque(T.base300) : opaque(T.base100)
  for (const pct of MODELED_BASE_CONTENT_TIERS) {
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
    add(
      `fill-${name}`,
      `${name}-content on ${name} fill`,
      opaque(content),
      opaque(fill),
      "large",
    )
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

  // Semantic text colors used directly as body text on a base surface — an
  // inline `text-error` validation message, a `text-success` confirmation, etc.
  // Distinct from the soft-badge pairs above (nudged token on a tinted ground):
  // here the raw token sits on the plain base-100 canvas, the realistic worst
  // case for an inline status message. The coverage guard scans src/** for
  // `text-<token>` utilities and fails if any used one has no pair here.
  const textSemanticToken: Record<
    (typeof MODELED_TEXT_SEMANTICS)[number],
    string
  > = {
    primary: T.primary,
    secondary: T.secondary,
    accent: T.accent,
    info: T.info,
    success: T.success,
    error: T.error,
    // warning text uses the AAA-darkened warningText (light) / warning (dark).
    warning: theme === "sumi" ? SUMI.warningText : DARK.warning,
  }
  for (const name of MODELED_TEXT_SEMANTICS) {
    add(
      `text-${name}`,
      `${name} text on base-100`,
      opaque(textSemanticToken[name]),
      opaque(T.base100),
      "body",
    )
  }

  // Link text (daisyUI .link / hover:text-primary) uses the per-theme link
  // color on base-100, body size (index.css --color-link override).
  add("link", "link on base-100", opaque(T.link), opaque(T.base100), "body")

  // Sidebar (dark rail in both themes). The index.css override remaps every
  // resting muted tier used on the rail (/50, /60, /70) to the same 85% floor,
  // so one pair represents them all; hover lifts to full neutral-content.
  const sidebarSurface =
    theme === "sumi" ? opaque(SUMI.sidebarSurface) : darkSidebarSurface()
  add(
    "sidebar-muted",
    `neutral-content resting tiers (rendered ${T.sidebarMuted}%) on sidebar surface`,
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
  add(
    "placeholder",
    "input placeholder",
    tierFg(T.baseContent, T.muted[70]),
    opaque(T.base100),
    "body",
  )
  add(
    "label",
    ".label text",
    tierFg(T.baseContent, T.muted[70]),
    opaque(T.base100),
    "body",
  )

  // Structural divider (base-300 on base-100): outside 1.4.11's scope since it's
  // not the sole means of identifying a control, so exempt. Precondition: if a
  // control ever relies on this border alone (an unfilled input, a selectable
  // card), it falls under 1.4.11 and needs a non-exempt pair at the 3:1 floor.
  add(
    "border",
    "base-300 structural divider on base-100",
    opaque(T.base300),
    opaque(T.base100),
    "body",
    "nonText",
    true,
  )

  return pairs
}

export const PAIRS: Pair[] = [...buildTheme("sumi"), ...buildTheme("sumi-dark")]

export type Evaluated = Pair & {
  ratio: number
  floor: number
  margin: number
  passesFloor: boolean
  passesMargin: boolean
  /** The bg as an opaque sRGB hex (the surface behind the text). */
  bgHex: string
  /** The fg as actually displayed: flattened over the opaque bg, as sRGB hex. */
  fgHex: string
}

/** Evaluate one pair against its spec floor and design margin. */
export function evaluate(p: Pair): Evaluated {
  const ratio = ratioOver(p.fg, p.bg)
  const floor = p.kind === "nonText" ? SPEC_FLOOR.nonText : SPEC_FLOOR[p.size]
  const margin =
    p.kind === "nonText" ? MARGIN_TARGET.nonText : MARGIN_TARGET[p.size]
  // Resolve the displayed colors: the bg is flattened to opaque (over white if
  // itself translucent), and the fg is composited over that bg — matching what
  // ratioOver scores and what a viewer actually sees.
  const opaqueBg = p.bg.a < 1 ? flattenOver(p.bg, parseColor("#ffffff")) : p.bg
  return {
    ...p,
    ratio,
    floor,
    margin,
    passesFloor: p.exempt || ratio >= floor,
    passesMargin: p.exempt || ratio >= margin,
    bgHex: toHex(opaqueBg),
    fgHex: toHex(flattenOver(p.fg, opaqueBg)),
  }
}

export const evaluateAll = (): Evaluated[] => PAIRS.map(evaluate)
