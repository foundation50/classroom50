import { describe, expect, it } from "vitest"

import {
  applyVerdicts,
  CONTRAST_CRITERION_IDS,
  CRITERIA,
  hasGenericRemark,
  PRINCIPLE_ORDER,
  type Criterion,
  type ConformanceLevel,
  type EvidenceKind,
  type VerdictOverlay,
  type WcagLevel,
  type WcagPrinciple,
} from "./vpatModel"

const VALID_STATUS = new Set<ConformanceLevel>([
  "supports",
  "partially",
  "doesNotSupport",
  "notApplicable",
  "notEvaluated",
])
const VALID_LEVEL = new Set<WcagLevel>(["A", "AA", "AAA"])
const VALID_EVIDENCE = new Set<EvidenceKind>([
  "contrast",
  "automated",
  "manual",
  "architectural",
])
const VALID_PRINCIPLE = new Set<WcagPrinciple>(PRINCIPLE_ORDER)

// The applicable SC set the model must cover (from the plan's criteria list).
// A dropped criterion — or a stray extra one — fails here loudly.
const EXPECTED_IDS = [
  "1.1.1",
  "1.3.1",
  "1.3.2",
  "1.3.5",
  "1.4.3",
  "1.4.6",
  "1.4.11",
  "1.4.4",
  "1.4.10",
  "1.4.12",
  "1.4.13",
  "2.1.1",
  "2.1.2",
  "2.4.1",
  "2.4.3",
  "2.4.4",
  "2.4.6",
  "2.4.7",
  "2.4.11",
  "2.5.3",
  "2.5.8",
  "3.1.1",
  "3.2.3",
  "3.2.4",
  "3.3.1",
  "3.3.2",
  "3.3.7",
  "3.3.8",
  "4.1.2",
  "4.1.3",
]

describe("vpatModel — criteria integrity", () => {
  it("has a unique id, valid enums, and a non-empty name/remark per criterion", () => {
    const seen = new Set<string>()
    for (const c of CRITERIA) {
      expect(seen.has(c.id), `duplicate criterion id ${c.id}`).toBe(false)
      seen.add(c.id)
      expect(c.name.length, `${c.id} name`).toBeGreaterThan(0)
      expect(c.remark.length, `${c.id} remark`).toBeGreaterThan(0)
      expect(VALID_LEVEL.has(c.level), `${c.id} level`).toBe(true)
      expect(VALID_STATUS.has(c.status), `${c.id} status`).toBe(true)
      expect(VALID_PRINCIPLE.has(c.principle), `${c.id} principle`).toBe(true)
      if (c.evidence !== undefined) {
        expect(VALID_EVIDENCE.has(c.evidence), `${c.id} evidence`).toBe(true)
      }
    }
  })

  it("never claims `supports` without an evidence tag (overclaim guard)", () => {
    for (const c of CRITERIA) {
      if (c.status === "supports") {
        expect(
          c.evidence,
          `${c.id} claims supports but has no evidence tag`,
        ).toBeDefined()
      }
    }
  })

  it("tags every notApplicable criterion architecturally with a remark", () => {
    for (const c of CRITERIA.filter((x) => x.status === "notApplicable")) {
      expect(c.evidence, `${c.id} N/A evidence`).toBe("architectural")
      expect(c.remark.length, `${c.id} N/A remark`).toBeGreaterThan(0)
    }
  })

  it("covers exactly the applicable success-criteria set", () => {
    const ids = CRITERIA.map((c) => c.id).sort()
    expect(ids).toEqual([...EXPECTED_IDS].sort())
  })

  it("lists the contrast criteria as contrast-evidence placeholders", () => {
    for (const id of CONTRAST_CRITERION_IDS) {
      const c = CRITERIA.find((x) => x.id === id)
      expect(c, `contrast criterion ${id} present`).toBeDefined()
      expect(c?.evidence, `${id} evidence`).toBe("contrast")
    }
  })

  it("marks 3.1.1 Language of Page as automated Supports (U4)", () => {
    const c = CRITERIA.find((x) => x.id === "3.1.1")
    expect(c?.status).toBe("supports")
    expect(c?.evidence).toBe("automated")
  })

  it.each(["3.3.1", "3.3.2", "4.1.3", "2.5.8", "1.4.10", "1.4.4", "1.4.12"])(
    "marks %s as automated Supports with a specific remark",
    (id) => {
      const c = CRITERIA.find((x) => x.id === id)
      expect(c?.status).toBe("supports")
      expect(c?.evidence).toBe("automated")
      expect(hasGenericRemark(c!)).toBe(false)
    },
  )
})

describe("vpatModel — applyVerdicts overlay", () => {
  const base: Criterion[] = [
    {
      id: "9.9.9",
      name: "Sample Outstanding",
      level: "A",
      principle: "Perceivable",
      status: "notEvaluated",
      remark: "not yet assessed",
    },
    {
      id: "8.8.8",
      name: "Sample Automated",
      level: "AA",
      principle: "Robust",
      status: "supports",
      evidence: "automated",
      remark: "machine-verified",
    },
  ]

  it("overlays a manual verdict onto a notEvaluated row", () => {
    const overlay: VerdictOverlay = {
      "9.9.9": { status: "supports", evidence: "manual", remark: "tested; ok" },
    }
    const [row] = applyVerdicts(base, overlay)
    expect(row).toMatchObject({
      id: "9.9.9",
      status: "supports",
      evidence: "manual",
      remark: "tested; ok",
    })
  })

  it("leaves rows without a verdict untouched and does not mutate the input", () => {
    const overlay: VerdictOverlay = {
      "9.9.9": { status: "partially", evidence: "manual", remark: "partial" },
    }
    const out = applyVerdicts(base, overlay)
    expect(out[1]).toEqual(base[1])
    expect(base[0].status).toBe("notEvaluated") // input unchanged
  })

  it("throws if a verdict targets a non-notEvaluated row (overwrite guard)", () => {
    const overlay: VerdictOverlay = {
      "8.8.8": { status: "supports", evidence: "manual", remark: "x" },
    }
    expect(() => applyVerdicts(base, overlay)).toThrow(/8\.8\.8/)
  })

  it("throws on a verdict for an unknown criterion id", () => {
    const overlay: VerdictOverlay = {
      "0.0.0": { status: "supports", evidence: "manual", remark: "x" },
    }
    expect(() => applyVerdicts(base, overlay)).toThrow(/unknown/)
  })

  // vpatVerdicts.json is a plain JSON overlay whose `as VerdictOverlay` cast is
  // compile-time only, so a hand-edited entry can carry any shape at runtime.
  // applyVerdicts must reject a payload that would overclaim — an automated
  // evidence tag, a non-manual status, or an empty remark — not just guard the
  // target row.
  it("throws if a verdict claims non-manual evidence (overclaim guard)", () => {
    const overlay = {
      "9.9.9": { status: "supports", evidence: "automated", remark: "x" },
    } as unknown as VerdictOverlay
    expect(() => applyVerdicts(base, overlay)).toThrow(/manual/)
  })

  it("throws if a verdict carries an invalid status", () => {
    const overlay = {
      "9.9.9": { status: "notEvaluated", evidence: "manual", remark: "x" },
    } as unknown as VerdictOverlay
    expect(() => applyVerdicts(base, overlay)).toThrow(/status/)
  })

  it("throws if a verdict has an empty remark", () => {
    const overlay: VerdictOverlay = {
      "9.9.9": { status: "supports", evidence: "manual", remark: "   " },
    }
    expect(() => applyVerdicts(base, overlay)).toThrow(/remark/)
  })
})
