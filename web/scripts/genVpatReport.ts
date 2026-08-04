// Writes vpat-report.json + VPAT.md (WCAG) + VPAT-508.md (Section 508) from the
// pure renderers. Run via `npm run audit:vpat` (vite-node resolves the `@/`
// alias + TS). The outputs are gitignored — never committed — because they are
// renderings of guarded state (vpatGuard.test.ts + the contrast guard enforce
// the facts). CI uploads them as build artifacts, and the Vite build emits them
// into dist/ (served at /vpat-report.json, /VPAT.md, /VPAT-508.md); this script
// is the local + CI generator. Content is built by src/util/vpatReport.ts.

import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { renderVpatJson, renderVpatReport } from "../src/util/vpatReport"

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.resolve(here, "..")

const outputs: [string, string][] = [
  ["vpat-report.json", renderVpatJson()],
  ["VPAT.md", renderVpatReport("wcag")],
  ["VPAT-508.md", renderVpatReport("508")],
]
for (const [name, body] of outputs) {
  const outPath = path.join(dir, name)
  writeFileSync(outPath, body, "utf8")
  console.log(`Wrote ${outPath}`)
}
