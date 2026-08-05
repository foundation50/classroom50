// Writes a11y-inventory.json — a criterion-tagged snapshot of what the VPAT is
// backed by: each criterion's status, evidence kind, and (for automated ones)
// the hermetic check that binds it. Gitignored and uploaded as a CI artifact,
// mirroring the contrast/VPAT report pattern; it's a rendering of guarded state
// (vpatAutomated.test.ts enforces the bindings), never committed. Run via
// `npm run audit:a11y:inventory`.

import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { buildVpatReport } from "../../src/util/a11y/vpatReport"
import { AUTOMATED_CRITERIA } from "../../src/util/a11y/vpatAutomated"

const report = buildVpatReport()
const inventory = {
  schema: "a11y-inventory/v1",
  generated: report.generated,
  summary: report.summary,
  criteria: report.criteria.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    evidence: c.evidence ?? null,
    boundCheck: AUTOMATED_CRITERIA[c.id]?.check ?? null,
  })),
}

const here = path.dirname(fileURLToPath(import.meta.url))
// scripts/a11y/ -> web/ (two levels up): output lands at the web root.
const outPath = path.join(path.resolve(here, "..", ".."), "a11y-inventory.json")
writeFileSync(outPath, JSON.stringify(inventory, null, 2) + "\n", "utf8")
console.log(`Wrote ${outPath}`)
