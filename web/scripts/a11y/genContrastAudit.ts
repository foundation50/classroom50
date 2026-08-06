// Writes CONTRAST-AUDIT.md from the pure renderer. Run via `npm run audit:contrast`
// (vite-node resolves the `@/` alias + TS). The output is gitignored — never
// committed — because it is a rendering of guaranteed-green state (the contrast
// guard tests enforce the facts). CI uploads it as a build artifact, and the
// Vite build emits it into dist/ (served at /CONTRAST-AUDIT.md); this script is
// the local + CI generator. Content is built by the pure, tested
// src/util/contrastReport.ts.

import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  renderContrastJson,
  renderContrastReport,
} from "../../src/util/a11y/contrastReport"

const here = path.dirname(fileURLToPath(import.meta.url))
// scripts/a11y/ -> web/ (two levels up): outputs land at the web root, served
// from dist/ and uploaded as CI artifacts.
const dir = path.resolve(here, "..", "..")

const outputs: [string, string][] = [
  ["contrast-audit.json", renderContrastJson()],
  ["CONTRAST-AUDIT.md", renderContrastReport()],
]
for (const [name, body] of outputs) {
  const outPath = path.join(dir, name)
  writeFileSync(outPath, body, "utf8")
  console.log(`Wrote ${outPath}`)
}
