import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import en from "@/locales/en.json"
import { flattenBundle } from "./customLocale"

// Guards against a `t("…")` call whose key doesn't exist in en.json. i18next
// falls back to rendering the raw key string at runtime when a key is missing,
// which ships green through typecheck/lint and the language-pack coverage check
// — this is the only gate that catches it. Complements customLocale's coverage
// (packs vs base): that measures translation completeness of external packs;
// this measures that our own call sites reference real base keys.

const SRC_DIR = fileURLToPath(new URL("..", import.meta.url))

// i18next plural/context keys expand the base key with suffixes; a call to
// t("x", { count }) is valid if x_one/x_other (etc.) exist. Accept a call key
// when it, or any of its suffixed forms, is present in the flattened base.
const PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many", "_other"]

const baseKeys = new Set(Object.keys(flattenBundle(en)))

function keyExists(key: string): boolean {
  if (baseKeys.has(key)) return true
  return PLURAL_SUFFIXES.some((suffix) => baseKeys.has(`${key}${suffix}`))
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walk(full))
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      out.push(full)
    }
  }
  return out
}

// Static t("…") / t('…') / t(`…`) calls with a plain string literal (no
// interpolation). Dynamic keys (t(variable) or t(`a.${x}`)) can't be checked
// statically and are skipped — this audit only asserts the literal call sites.
const T_CALL = /\bt\(\s*(["'`])((?:(?!\1)[^\\$]|\\.)*)\1/g

describe("i18n key audit", () => {
  it("no key segment in en.json contains a dot", () => {
    // Every flattener in the pipeline (flattenBundle, verify_locale.py,
    // audit_i18n.py, translate_locales.py) joins segments with "." and splits
    // them back the same way, so a leaf named "2.1" flattens to a path that no
    // longer resolves. i18next happens to tolerate it, which is why only the
    // translation workflow noticed.
    const dotted: string[] = []
    const walkKeys = (node: unknown, path: string[]) => {
      if (!node || typeof node !== "object") return
      for (const [segment, value] of Object.entries(node)) {
        const here = [...path, segment]
        if (segment.includes(".")) dotted.push(here.join("/"))
        walkKeys(value, here)
      }
    }
    walkKeys(en, [])
    expect(
      dotted,
      `en.json key segments must not contain "." (shown as nested paths):\n${dotted
        .map((k) => `  ${k}`)
        .join("\n")}`,
    ).toEqual([])
  })

  it('every static t("…") key exists in en.json', () => {
    const missing: { file: string; key: string }[] = []
    for (const file of walk(SRC_DIR)) {
      const text = readFileSync(file, "utf8")
      for (const match of text.matchAll(T_CALL)) {
        const key = match[2]
        // Skip template literals that contained an interpolation (the regex
        // excludes `$`, so a captured `${` never reaches here) and empty keys.
        if (!key || key.includes("${")) continue
        if (!keyExists(key)) {
          missing.push({ file: file.replace(SRC_DIR, ""), key })
        }
      }
    }
    expect(
      missing,
      `Found t() calls whose key is missing from en.json (would render the raw key at runtime):\n${missing
        .map((m) => `  ${m.key}  (${m.file})`)
        .join("\n")}`,
    ).toEqual([])
  })
})
