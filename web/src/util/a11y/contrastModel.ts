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
} from "./contrast.ts"

export type SizeClass = "body" | "large"
export type Theme = "sumi" | "sumi-dark"

/** WCAG 1.4.3 (AA text) / 1.4.11 (non-text) spec floors — what the guard enforces. */
export const SPEC_FLOOR = { body: 4.5, large: 3, nonText: 3 } as const
/** Design-target margins (reported, non-blocking per the guard-strictness decision). */
export const MARGIN_TARGET = { body: 5, large: 3.5, nonText: 3.5 } as const
/**
 * WCAG 1.4.6 (Enhanced, AAA) text floors. Measured but NOT enforced: the palette
 * is GitHub Primer verbatim, and Primer's primitives are tuned to AA. Scoring it
 * anyway keeps the VPAT's 1.4.6 row derived from the live audit (KTD4) instead of
 * hand-set, so the claim can't drift from the palette. Non-text has no AAA tier,
 * so those pairs reuse the AA floor.
 */
export const ENHANCED_FLOOR = { body: 7, large: 4.5, nonText: 3 } as const

export type Kind = "text" | "nonText"

// Which `text-base-content/NN` and `text-neutral-content/NN` opacity tiers the
// model audits. The coverage guard (contrastSource.test.ts) scans src/** and
// fails if a tier used on text is missing here — turning the "a pair present in
// JSX but absent here is an audit gap" comment into an enforced check.
export const MODELED_BASE_CONTENT_TIERS = [30, 40, 50, 60, 70, 80, 90] as const
export const MODELED_NEUTRAL_CONTENT_TIERS = [50, 60, 70] as const

// Rest-dim factor for the sidebar rail (index.css .sidebar-rail): the rail
// background sits at this % of `neutral` mixed toward black until hovered or
// focused. The drift guard in contrastSource.test.ts asserts the CSS recipe
// uses the same factor, so the audited pair can't silently diverge.
export const SIDEBAR_REST_DIM = 90

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
// Light theme "sumi" — GitHub Primer's light primitives, verbatim. Each role
// token is Primer's `fgColor-<role>` (not the `bgColor-*-emphasis` fill), since
// one daisyUI token serves both text and fill; see the index.css rationale.
export const SUMI = {
  base100: "#ffffff",
  base200: "#f6f8fa",
  base300: "#d1d9e0",
  baseContent: "#1f2328",
  primary: "#1a7f37",
  primaryContent: "#ffffff",
  secondary: "#59636e",
  secondaryContent: "#ffffff",
  accent: "#8250df",
  accentContent: "#ffffff",
  neutral: "#25292e",
  neutralContent: "#ffffff",
  info: "#0969da",
  infoContent: "#ffffff",
  success: "#1a7f37",
  successContent: "#ffffff",
  warning: "#9a6700",
  warningContent: "#ffffff",
  error: "#d1242f",
  errorContent: "#ffffff",
  // Sidebar: opaque Primer neutral panel over the light canvas.
  sidebarSurface: "#3d444d",
  // Per-theme link color and muted-tier opacity floors (index.css overrides).
  link: "#0969da",
  muted: { 30: 68, 40: 68, 50: 70, 60: 74, 70: 78, 80: 86, 90: 93 } as Record<
    number,
    number
  >,
  badgeNudge: 82,
  sidebarMuted: 72,
} as const

// Dark theme "sumi-dark" — Primer's dark primitives. Exported for the drift
// guard (see SUMI).
export const DARK = {
  base100: "#0d1117",
  base200: "#151b23",
  base300: "#3d444d",
  baseContent: "#f0f6fc",
  primary: "#3fb950",
  primaryContent: "#0d1117",
  secondary: "#9198a1",
  secondaryContent: "#0d1117",
  accent: "#ab7df8",
  accentContent: "#0d1117",
  neutral: "#212830",
  neutralContent: "#f0f6fc",
  info: "#4493f8",
  infoContent: "#0d1117",
  success: "#3fb950",
  successContent: "#0d1117",
  warning: "#d29922",
  warningContent: "#0d1117",
  error: "#f85149",
  errorContent: "#0d1117",
  // Per-theme link color and muted-tier opacity floors (index.css overrides).
  link: "#4493f8",
  muted: { 30: 52, 40: 52, 50: 58, 60: 66, 70: 74, 80: 84, 90: 92 } as Record<
    number,
    number
  >,
  badgeNudge: 88,
  sidebarMuted: 72,
} as const

// The dark sidebar surface is a translucent sheet over base-100, NOT the light
// theme's opaque panel.
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

  // Muted tiers at their AA-remapped opacities (index.css), audited against the
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
    ["warning", T.warning, T.warningContent],
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
    ["warning", T.warning],
    ["error", T.error],
  ]
  for (const [name, token] of semantics) {
    add(
      `badge-${name}`,
      `${name} soft-badge text`,
      badgeSoftFg(theme, token),
      softGround(token, theme === "sumi" ? T.base200 : T.base100),
      "body",
    )
  }

  // Semantic text colors used directly as body text on a base surface — an
  // inline `text-error` validation message, a `text-success` confirmation, etc.
  // Distinct from the soft-badge pairs above (nudged token on a tinted ground):
  // here the raw token sits on the worst-case realistic ground for an inline
  // status message. Since the canvas went white with muted base-200 cards
  // (GitHub Product UI), the light worst case is base-200; in dark, cards are
  // DARKER than the canvas, so base-100 stays the worst case there. The
  // coverage guard scans src/** for `text-<token>` utilities and fails if any
  // used one has no pair here.
  const semanticWorstBg =
    theme === "sumi" ? opaque(T.base200) : opaque(T.base100)
  const semanticWorstLabel = theme === "sumi" ? "base-200" : "base-100"
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
    warning: T.warning,
  }
  for (const name of MODELED_TEXT_SEMANTICS) {
    add(
      `text-${name}`,
      `${name} text on ${semanticWorstLabel}`,
      opaque(textSemanticToken[name]),
      semanticWorstBg,
      "body",
    )
  }

  // Link text (daisyUI .link / hover:text-primary) uses the per-theme link
  // color, body size (index.css --color-link override), on the same
  // worst-case ground as the inline semantics.
  add(
    "link",
    `link on ${semanticWorstLabel}`,
    opaque(T.link),
    semanticWorstBg,
    "body",
  )

  // Sidebar (dark rail in both themes). The index.css override remaps every
  // resting muted tier used on the rail (/50, /60, /70) to the same 72% floor,
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

  // Rest-dimmed rail (index.css .sidebar-rail): on hover-capable pointers the
  // rail background darkens to SIDEBAR_REST_DIM% of `neutral` toward black
  // until hovered or focused. Text stays at the resting 72% tier, so audit
  // that text over the dimmed surface — the darkest ground rail text ever
  // sits on.
  add(
    "sidebar-rest-dim",
    `neutral-content resting tiers (rendered ${T.sidebarMuted}%) on rest-dimmed rail`,
    tierFg(T.neutralContent, T.sidebarMuted),
    mixColor("oklab", T.neutral, SIDEBAR_REST_DIM, "black"),
    "body",
  )

  // Placeholder renders inside the input's own base-100 field; .label sits on
  // the surrounding surface, so it takes the per-polarity worst-case ground
  // (base-200 cards in light). Both render at the muted-70 floor (index.css).
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
    semanticWorstBg,
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
  /** The AAA (1.4.6) floor for this pair; reported, never enforced. */
  enhancedFloor: number
  passesEnhanced: boolean
  /** The bg as an opaque sRGB hex (the surface behind the text). */
  bgHex: string
  /** The fg as actually displayed: flattened over the opaque bg, as sRGB hex. */
  fgHex: string
}

/** Evaluate one pair against its spec floor, design margin, and the AAA floor. */
export function evaluate(p: Pair): Evaluated {
  const ratio = ratioOver(p.fg, p.bg)
  const floor = p.kind === "nonText" ? SPEC_FLOOR.nonText : SPEC_FLOOR[p.size]
  const margin =
    p.kind === "nonText" ? MARGIN_TARGET.nonText : MARGIN_TARGET[p.size]
  const enhancedFloor =
    p.kind === "nonText" ? ENHANCED_FLOOR.nonText : ENHANCED_FLOOR[p.size]
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
    enhancedFloor,
    passesEnhanced: p.exempt || ratio >= enhancedFloor,
    bgHex: toHex(opaqueBg),
    fgHex: toHex(flattenOver(p.fg, opaqueBg)),
  }
}

export const evaluateAll = (): Evaluated[] => PAIRS.map(evaluate)
