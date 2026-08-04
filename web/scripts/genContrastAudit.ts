// Writes CONTRAST-AUDIT.md from the pure renderer. Run via `npm run audit:contrast`
// (vite-node resolves the `@/` alias + TS). Kept out of src/ because it performs
// file I/O and is not part of the app bundle; the report content itself is built
// by the pure, tested src/util/contrastReport.ts.

import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { renderContrastReport } from "../src/util/contrastReport"

const here = path.dirname(fileURLToPath(import.meta.url))
const outPath = path.resolve(here, "..", "CONTRAST-AUDIT.md")

writeFileSync(outPath, renderContrastReport(), "utf8")
console.log(`Wrote ${outPath}`)
