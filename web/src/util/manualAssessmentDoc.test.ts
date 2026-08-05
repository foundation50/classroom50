import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  ASSESSMENT_GUIDANCE,
  outstandingCriteria,
  renderManualAssessment,
} from "./manualAssessmentDoc"

// Freshness guard: the committed checklist must equal the renderer output, the
// same discipline the contrast/VPAT renderers use. Regenerate the file from
// renderManualAssessment() rather than hand-editing prose.
const here = path.dirname(fileURLToPath(import.meta.url))
const checklistPath = path.resolve(
  here,
  "..",
  "..",
  "accessibility",
  "manual-assessment.md",
)

describe("manualAssessmentDoc renderer", () => {
  it("matches the committed manual-assessment.md byte-for-byte", () => {
    const committed = readFileSync(checklistPath, "utf8")
    expect(renderManualAssessment()).toBe(committed)
  })

  it("has guidance for every outstanding criterion", () => {
    const guidanceIds = new Set(ASSESSMENT_GUIDANCE.map((g) => g.id))
    for (const c of outstandingCriteria()) {
      expect(guidanceIds.has(c.id), `guidance for ${c.id}`).toBe(true)
    }
  })

  it("gives every guidance entry a non-empty bullet set", () => {
    for (const g of ASSESSMENT_GUIDANCE) {
      expect(g.bullets.length, `${g.id} bullets`).toBeGreaterThan(0)
      for (const b of g.bullets) {
        expect(b.label.length, `${g.id} label`).toBeGreaterThan(0)
        expect(b.text.length, `${g.id} text`).toBeGreaterThan(0)
      }
    }
  })
})
