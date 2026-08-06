import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { CONTRAST_CRITERION_IDS, CRITERIA } from "./vpatModel"
import { buildVpatReport } from "./vpatReport"
import { AUTOMATED_CRITERIA, BROWSER_CI_DISCLOSURE } from "./vpatAutomated"
import { documentHasLang } from "./a11yStructural"

// U3 (map integrity) + U5 (per-criterion binding guard) for the `automated`
// VPAT verdicts. Each `automated` criterion must (a) be a real, non-contrast
// criterion and (b) have its backing check re-run and pass here — so a
// regression fails this test and the divergence can't merge (plan KTD2).

const modelIds = new Set(CRITERIA.map((c) => c.id))

describe("AUTOMATED_CRITERIA map integrity (U3)", () => {
  it("references only real criteria in the model", () => {
    for (const id of Object.keys(AUTOMATED_CRITERIA)) {
      expect(modelIds.has(id), `${id} not in CRITERIA`).toBe(true)
    }
  })

  it("never lists a contrast criterion (those are derived, KTD5)", () => {
    for (const id of CONTRAST_CRITERION_IDS) {
      expect(
        AUTOMATED_CRITERIA[id],
        `${id} must not be automated`,
      ).toBeUndefined()
    }
  })

  it("every entry has a non-empty check name and remark", () => {
    for (const [id, b] of Object.entries(AUTOMATED_CRITERIA)) {
      expect(b.check.length, `${id} check`).toBeGreaterThan(0)
      expect(b.remark.length, `${id} remark`).toBeGreaterThan(0)
    }
  })

  // Deploy-gate fidelity guard (finding #3): the deploy/release path runs the
  // browser-free `test:node` gate, so a browser-only criterion isn't re-verified
  // for the ref a manual redeploy publishes. This node-project test runs in that
  // gate, so it fails if a browser-only criterion loses its browserBacked flag
  // or its remark drops the CI-lane disclosure.
  const BROWSER_BACKED_IDS = ["2.5.8", "1.4.10", "1.4.4", "1.4.12"]

  it("the known browser-only criteria are flagged browserBacked", () => {
    for (const id of BROWSER_BACKED_IDS) {
      expect(
        AUTOMATED_CRITERIA[id]?.browserBacked,
        `${id} is backed only by a browser test but is not flagged browserBacked`,
      ).toBe(true)
    }
  })

  it("every browserBacked criterion discloses the CI-lane dependency in its remark", () => {
    for (const [id, b] of Object.entries(AUTOMATED_CRITERIA)) {
      if (!b.browserBacked) continue
      expect(
        b.remark.includes(BROWSER_CI_DISCLOSURE),
        `${id} is browserBacked but its remark omits the CI-lane disclosure — a manual redeploy of an un-CI'd ref would ship this Supports claim unverified`,
      ).toBe(true)
    }
  })
})

describe("per-criterion binding guard (U5)", () => {
  // Reverse closure: every criterion the model tags `automated` must have a
  // binding here — no verdict without a backing check.
  it("every automated criterion in the model has a binding", () => {
    const report = buildVpatReport()
    for (const c of report.criteria) {
      if (c.evidence === "automated") {
        expect(
          AUTOMATED_CRITERIA[c.id],
          `${c.id} is tagged automated but has no bound check`,
        ).toBeDefined()
      }
    }
  })

  // The actual backing check for 3.1.1: the shipped index.html declares lang.
  it("3.1.1 — index.html declares a non-empty <html lang>", () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    // src/util/a11y/ -> web/ (three levels up).
    const repoWeb = path.resolve(here, "..", "..", "..")
    const html = readFileSync(path.join(repoWeb, "index.html"), "utf8")
    const match = /<html[^>]*\blang="([^"]*)"/i.exec(html)
    expect(match, "no <html lang> in index.html").not.toBeNull()
    expect(documentHasLang(match?.[1])).toBe(true)
  })
})
