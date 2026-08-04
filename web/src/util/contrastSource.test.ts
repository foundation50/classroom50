import { readdirSync, readFileSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  DARK,
  MODELED_BASE_CONTENT_TIERS,
  MODELED_NEUTRAL_CONTENT_TIERS,
  SUMI,
} from "./contrastModel"

// Ties the audit model to the two things it can silently drift from: the token
// values in index.css (the palette the browser actually renders) and the set of
// muted opacity tiers used on text across src/**. Without these checks the guard
// audits a self-consistent copy of the palette and a hand-listed set of pairs,
// so a CSS edit or a newly-used tier regresses in the real UI while CI stays
// green. vitest runs in node, so reading the files here is legitimate.

const here = path.dirname(fileURLToPath(import.meta.url))
const repoWeb = path.resolve(here, "..", "..")
const cssText = readFileSync(path.join(repoWeb, "src/index.css"), "utf8")

// Read a CSS custom property for a theme. A token can appear twice (daisyUI
// `@plugin "daisyui/theme"` base value + a `[data-theme=...]` AAA override), so
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
    ["sumi", "color-warning", SUMI.warningText],
    ["sumi", "color-warning-fill", SUMI.warningFill],
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
