import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"

import { THEME_STORAGE_KEY, type Theme } from "./useTheme"

// The anti-flash inline script in index.html hand-mirrors resolveInitialTheme
// (same storage key + theme names) so the pre-mount paint matches what React
// resolves. Nothing else binds them and the drift symptom (a wrong-theme flash)
// is nearly invisible in review — so guard the contract here, like the repo's
// other hand-mirrored-contract drift tests (e.g. skeleton.test.ts).
describe("theme anti-flash contract (index.html <-> useTheme)", () => {
  const indexHtml = readFileSync(
    fileURLToPath(new URL("../../index.html", import.meta.url)),
    "utf8",
  )
  const THEMES: Theme[] = ["corporate", "corporate-dark"]

  it("index.html references the same storage key", () => {
    expect(indexHtml).toContain(THEME_STORAGE_KEY)
  })

  it("index.html references every registered theme name", () => {
    for (const theme of THEMES) {
      expect(indexHtml, `index.html missing theme name: ${theme}`).toContain(
        `"${theme}"`,
      )
    }
  })
})
