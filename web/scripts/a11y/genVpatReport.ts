// Writes vpat-report.json + VPAT.md (WCAG) + VPAT-INT.md (INT: Section 508 +
// EN 301 549 + WCAG 2.2) + ACCESSIBILITY-REPORT.md (both editions + the contrast
// audit in one file) from the pure renderers. Run via `npm run audit:vpat`
// (vite-node resolves the `@/` alias + TS). The outputs are gitignored — never
// committed — because they are renderings of guarded state (vpatGuard.test.ts +
// the contrast guard enforce the facts). CI uploads them as build artifacts, and
// the Vite build emits them into dist/ (served at /vpat-report.json, /VPAT.md,
// /VPAT-INT.md); this script is the local + CI generator. Content is built by
// src/util/a11y/vpatReport.ts.

import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  renderCombinedReport,
  renderVpatJson,
  renderVpatReport,
} from "../../src/util/a11y/vpatReport"

const here = path.dirname(fileURLToPath(import.meta.url))
// scripts/a11y/ -> web/ (two levels up): outputs land at the web root.
const dir = path.resolve(here, "..", "..")

const outputs: [string, string][] = [
  ["vpat-report.json", renderVpatJson()],
  ["VPAT.md", renderVpatReport("wcag")],
  ["VPAT-INT.md", renderVpatReport("int")],
  ["ACCESSIBILITY-REPORT.md", renderCombinedReport()],
]
for (const [name, body] of outputs) {
  const outPath = path.join(dir, name)
  writeFileSync(outPath, body, "utf8")
  console.log(`Wrote ${outPath}`)
}
