import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { CRITERIA, hasGenericRemark } from "./vpatModel"

// Keeps the committed manual-assessment checklist (web/accessibility/
// manual-assessment.md) in lockstep with the VPAT model. The checklist must have
// exactly one section per still-outstanding SC — a `notEvaluated`, no-evidence
// criterion (hasGenericRemark). As a human records a `manual` verdict in
// vpatModel.ts, that SC drops out of the outstanding set and its checklist
// section must be removed; a drifted checklist (missing an outstanding SC, or
// keeping a section for an already-assessed one) fails here. This is coverage
// tracking; the supports-requires-evidence rule is owned by vpatGuard.test.ts.

const here = path.dirname(fileURLToPath(import.meta.url))
const checklistPath = path.resolve(
  here,
  "..",
  "..",
  "accessibility",
  "manual-assessment.md",
)

// The SC ids the model still needs a human to assess.
const outstanding = CRITERIA.filter(hasGenericRemark)
  .map((c) => c.id)
  .sort()

// The SC ids the checklist documents, from its `### N.N.N Name (Level)` headings.
const checklist = readFileSync(checklistPath, "utf8")
const documented = Array.from(checklist.matchAll(/^###\s+(\d+\.\d+\.\d+)\b/gm))
  .map((m) => m[1])
  .sort()

describe("manual-assessment checklist ↔ VPAT model", () => {
  it("documents exactly the still-outstanding SCs (no drift)", () => {
    expect(documented).toEqual(outstanding)
  })

  it("has no duplicate SC sections", () => {
    expect(new Set(documented).size).toBe(documented.length)
  })

  // Guards the "fully assessed" future: when nothing is outstanding, the
  // checklist should be empty of SC sections and this still passes (both []).
  it("stays consistent when the outstanding set is empty", () => {
    if (outstanding.length === 0) {
      expect(documented).toEqual([])
    }
  })
})
