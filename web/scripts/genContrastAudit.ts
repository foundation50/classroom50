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

import { renderContrastReport } from "../src/util/contrastReport"

const here = path.dirname(fileURLToPath(import.meta.url))
const outPath = path.resolve(here, "..", "CONTRAST-AUDIT.md")

writeFileSync(outPath, renderContrastReport(), "utf8")
console.log(`Wrote ${outPath}`)
