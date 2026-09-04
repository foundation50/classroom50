// Writes vpat-report.json + VPAT.md (WCAG) + ACCESSIBILITY-REPORT.md (the VPAT +
// the contrast audit in one file) from the pure renderers. Run via `npm run audit:vpat`
// (vite-node resolves the `@/` alias + TS). The outputs are gitignored — never
// committed — because they are renderings of guarded state (vpatGuard.test.ts +
// the contrast guard enforce the facts). CI uploads them as build artifacts, and
// the Vite build emits them into dist/ (served at /vpat-report.json, /VPAT.md,
// /ACCESSIBILITY-REPORT.md); this script is the local + CI generator. Content is
// built by src/util/a11y/vpatReport.ts.

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

// Same precedence as vite.config.ts's release info: a `web-v*` release tag in
// CI, else package.json (npm exposes it to scripts it runs).
const version =
  (process.env.VITE_APP_VERSION || "").replace(/^web-v/, "") ||
  process.env.npm_package_version ||
  undefined
const options = { version }

const outputs: [string, string][] = [
  ["vpat-report.json", renderVpatJson(undefined, options)],
  ["VPAT.md", renderVpatReport(undefined, options)],
  ["ACCESSIBILITY-REPORT.md", renderCombinedReport(undefined, options)],
]
for (const [name, body] of outputs) {
  const outPath = path.join(dir, name)
  writeFileSync(outPath, body, "utf8")
  console.log(`Wrote ${outPath}`)
}
