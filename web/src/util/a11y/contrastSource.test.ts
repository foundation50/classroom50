import { readdirSync, readFileSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  DARK,
  MODELED_BASE_CONTENT_TIERS,
  MODELED_NEUTRAL_CONTENT_TIERS,
  MODELED_TEXT_SEMANTICS,
  SIDEBAR_REST_DIM,
  SUMI,
} from "./contrastModel"

// Ties the audit model to the two things it can silently drift from: the token
// values in index.css (the palette the browser actually renders) and the set of
// muted opacity tiers used on text across src/**. Without these checks the guard
// audits a self-consistent copy of the palette and a hand-listed set of pairs,
// so a CSS edit or a newly-used tier regresses in the real UI while CI stays
// green. vitest runs in node, so reading the files here is legitimate.

const here = path.dirname(fileURLToPath(import.meta.url))
// src/util/a11y/ -> web/ (three levels up).
const repoWeb = path.resolve(here, "..", "..", "..")
const cssText = readFileSync(path.join(repoWeb, "src/index.css"), "utf8")

// Read a CSS custom property for a theme. A token can appear twice (daisyUI
// `@plugin "daisyui/theme"` base value + a `[data-theme=...]` AA override), so
// return the LAST match — the effective, override-wins value.
function cssVar(theme: "sumi" | "sumi-dark", token: string): string | null {
  // Match either `name: "<theme>"` plugin blocks or `[data-theme="<theme>"]`
  // selector blocks, capturing their body up to the closing brace.
  const blocks: string[] = []
  const pluginRe = new RegExp(
    `@plugin\\s+"daisyui/theme"\\s*\\{[^}]*?name:\\s*"${theme}"[\\s\\S]*?\\n\\}`,
    "g",
  )
  const selectorRe = new RegExp(
    `\\[data-theme="${theme}"\\]\\s*\\{[^}]*\\}`,
    "g",
  )
  for (const re of [pluginRe, selectorRe]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(cssText)) !== null) blocks.push(m[0])
  }
  let value: string | null = null
  const varRe = new RegExp(`--${token}:\\s*([^;]+);`)
  for (const block of blocks) {
    const m = varRe.exec(block)
    if (m) value = m[1].trim()
  }
  return value
}

const norm = (hex: string) => hex.trim().toLowerCase()

describe("model tokens stay in sync with index.css (drift guard)", () => {
  const cases: [string, string, string][] = [
    // [theme, --css-token, model value]
    ["sumi", "color-base-100", SUMI.base100],
    ["sumi", "color-base-200", SUMI.base200],
    ["sumi", "color-base-300", SUMI.base300],
    ["sumi", "color-base-content", SUMI.baseContent],
    ["sumi", "color-primary", SUMI.primary],
    ["sumi", "color-secondary", SUMI.secondary],
    ["sumi", "color-accent", SUMI.accent],
    ["sumi", "color-info", SUMI.info],
    ["sumi", "color-success", SUMI.success],
    ["sumi", "color-error", SUMI.error],
    ["sumi", "color-warning", SUMI.warning],
    ["sumi", "color-link", SUMI.link],
    ["sumi", "sidebar-surface", SUMI.sidebarSurface],
    ["sumi-dark", "color-base-100", DARK.base100],
    ["sumi-dark", "color-base-200", DARK.base200],
    ["sumi-dark", "color-base-300", DARK.base300],
    ["sumi-dark", "color-base-content", DARK.baseContent],
    ["sumi-dark", "color-primary", DARK.primary],
    ["sumi-dark", "color-secondary", DARK.secondary],
    ["sumi-dark", "color-accent", DARK.accent],
    ["sumi-dark", "color-info", DARK.info],
    ["sumi-dark", "color-success", DARK.success],
    ["sumi-dark", "color-error", DARK.error],
    ["sumi-dark", "color-warning", DARK.warning],
    ["sumi-dark", "color-link", DARK.link],
  ]

  it.each(cases)("%s --%s matches the model", (theme, token, modelValue) => {
    const css = cssVar(theme as "sumi" | "sumi-dark", token)
    expect(
      css,
      `--${token} not found in the ${theme} theme block of index.css`,
    ).not.toBeNull()
    expect(norm(css as string)).toBe(norm(modelValue))
  })

  it("muted-tier opacity floors match index.css --muted-NN", () => {
    for (const [theme, map] of [
      ["sumi", SUMI.muted],
      ["sumi-dark", DARK.muted],
    ] as const) {
      for (const pct of MODELED_BASE_CONTENT_TIERS) {
        const css = cssVar(theme, `muted-${pct}`)
        expect(css, `--muted-${pct} missing in ${theme}`).not.toBeNull()
        expect(parseInt(css as string, 10)).toBe(map[pct])
      }
    }
  })

  it("sidebar rest-dim factor matches the .sidebar-rail recipe", () => {
    // The model audits the dimmed rail at SIDEBAR_REST_DIM% of `neutral`
    // toward black; the CSS recipe must mix by the same factor or the
    // audited pair diverges from what the browser renders.
    expect(cssText).toContain(
      `color-mix(in oklab, var(--color-neutral) ${SIDEBAR_REST_DIM}%, black)`,
    )
  })
})

// ── Coverage guard: every muted tier used on text in src/** must be modeled ──
// Scan .tsx sources for `text-base-content/NN` and `text-neutral-content/NN`.
// A tier used on real text but absent from the model is an unaudited pair the
// guard can't protect. Icons are decorative (exempt), but a global utility
// override raises them too, so modeling every used tier is safe and correct.

function usedTiers(prefix: string): Set<number> {
  const out = new Set<number>()
  // Match `text-base-content/40` as written in JSX className strings.
  const re = new RegExp(`${prefix}/(\\d+)`, "g")
  const srcDir = path.join(repoWeb, "src")
  const walk = (dir: string): string[] => {
    const entries = readdirSync(dir)
    const files: string[] = []
    for (const e of entries) {
      const full = path.join(dir, e)
      if (statSync(full).isDirectory()) files.push(...walk(full))
      else if (e.endsWith(".tsx") || e.endsWith(".ts")) files.push(full)
    }
    return files
  }
  for (const file of walk(srcDir)) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue
    const text = readFileSync(file, "utf8")
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) out.add(parseInt(m[1], 10))
  }
  return out
}

describe("every muted tier used on text is modeled (coverage guard)", () => {
  it("text-base-content/NN tiers are all audited", () => {
    const used = usedTiers("text-base-content")
    const modeled = new Set<number>(MODELED_BASE_CONTENT_TIERS)
    const unmodeled = [...used].filter((t) => !modeled.has(t))
    expect(
      unmodeled,
      `text-base-content/${unmodeled.join(",")} used in src/** but not audited by the model. Add the tier to MODELED_BASE_CONTENT_TIERS and remap it in index.css, or the guard can't protect it.`,
    ).toEqual([])
  })

  it("text-neutral-content/NN tiers are all audited", () => {
    const used = usedTiers("text-neutral-content")
    const modeled = new Set<number>(MODELED_NEUTRAL_CONTENT_TIERS)
    const unmodeled = [...used].filter((t) => !modeled.has(t))
    expect(
      unmodeled,
      `text-neutral-content/${unmodeled.join(",")} used in src/** but not modeled/remapped for the sidebar rail.`,
    ).toEqual([])
  })
})

// ── Coverage guard: every semantic text color used on text in src/** is modeled ──
// Beyond the muted base/neutral tiers above, a semantic `text-error` /
// `text-primary` / `text-success` etc. rendered as plain text on a base surface
// is its own (foreground, surface) pair. Without this scan the audit would keep
// claiming contrast "Supports" while an inline status color drifts low-contrast.
// Excludes `-content` foregrounds (those sit on a matching fill, a different
// modeled pair) and the muted `/NN` variants already covered above.
function usedTextSemantics(): Set<string> {
  const out = new Set<string>()
  const names = MODELED_TEXT_SEMANTICS.join("|")
  // `text-error` / `text-primary`, but NOT `text-error-content`, `text-primary/40`,
  // or a longer word like `text-primaryish` (word-boundary the tail).
  const re = new RegExp(`text-(${names})(?![\\w/-])`, "g")
  const srcDir = path.join(repoWeb, "src")
  const walk = (dir: string): string[] => {
    const files: string[] = []
    for (const e of readdirSync(dir)) {
      const full = path.join(dir, e)
      if (statSync(full).isDirectory()) files.push(...walk(full))
      else if (e.endsWith(".tsx") || e.endsWith(".ts")) files.push(full)
    }
    return files
  }
  for (const file of walk(srcDir)) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue
    const text = readFileSync(file, "utf8")
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) out.add(m[1])
  }
  return out
}

describe("every semantic text color used on text is modeled (coverage guard)", () => {
  it("text-<semantic> utilities used in src/** are all audited", () => {
    const used = usedTextSemantics()
    const modeled = new Set<string>(MODELED_TEXT_SEMANTICS)
    const unmodeled = [...used].filter((name) => !modeled.has(name))
    expect(
      unmodeled,
      `text-${unmodeled.join(", text-")} used in src/** but not audited. Add the token to MODELED_TEXT_SEMANTICS + a text-<name> pair in contrastModel.ts (or, if only ever decorative/large, exempt it explicitly).`,
    ).toEqual([])
  })
})
