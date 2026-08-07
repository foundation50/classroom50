import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import {
  SUBMISSION_TAGS_CAP,
  matchesSubmissionTag,
  parseSubmissionTags,
  safeShimTagPatterns,
  submissionTagsToText,
  validateSubmissionTags,
} from "./submissionTags"

// The web half of the matcher lockstep: the same golden cases the Go
// contract.MatchesSubmissionTag and the Python copies assert. A drift on any
// side fails its fixture test — the pattern strings go verbatim into the
// shim's on.push.tags, so every evaluator must agree on what fires.
describe("matchesSubmissionTag — shared fixture parity", () => {
  const fixtureUrl = new URL(
    "../../../cli/shared/testdata/submission_tag_match_cases.json",
    import.meta.url,
  )
  const doc = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf8")) as {
    cases: { patterns: string[]; tag: string; matches: boolean }[]
  }

  it("has cases", () => {
    expect(doc.cases.length).toBeGreaterThan(0)
  })

  for (const [i, c] of doc.cases.entries()) {
    it(`case ${i}: [${c.patterns.join(", ")}] vs "${c.tag}" -> ${c.matches}`, () => {
      expect(matchesSubmissionTag(c.patterns, c.tag)).toBe(c.matches)
    })
  }
})

describe("matchesSubmissionTag — fail-closed on uncompilable patterns", () => {
  it("an invalid pattern matches nothing and doesn't poison later ones", () => {
    // A reversed character-class range fails RegExp compilation.
    expect(matchesSubmissionTag(["[z-a]"], "m")).toBe(false)
    expect(matchesSubmissionTag(["[z-a]", "good"], "good")).toBe(true)
  })
})

describe("parseSubmissionTags / submissionTagsToText", () => {
  it("splits lines, trims, drops blanks, round-trips", () => {
    expect(parseSubmissionTags(" phase1 \n\nphase2\r\ncomplete\n")).toEqual([
      "phase1",
      "phase2",
      "complete",
    ])
    expect(submissionTagsToText(["phase1", "v*"])).toBe("phase1\nv*")
    expect(submissionTagsToText(undefined)).toBe("")
  })
})

describe("validateSubmissionTags", () => {
  it("accepts valid pattern lists (and the empty list)", () => {
    expect(validateSubmissionTags([])).toBeUndefined()
    expect(
      validateSubmissionTags(["phase1", "v*", "release-[0-9]", "a/b?"]),
    ).toBeUndefined()
  })

  it("rejects exclude patterns, bad charset, duplicates, and over-cap", () => {
    expect(validateSubmissionTags(["!v*"])).toMatch(/exclude/)
    expect(validateSubmissionTags(['ta"g'])).toMatch(/may only use/)
    expect(validateSubmissionTags(["has space"])).toMatch(/may only use/)
    expect(validateSubmissionTags(["dup", "dup"])).toMatch(/more than once/)
    expect(
      validateSubmissionTags(
        Array.from({ length: SUBMISSION_TAGS_CAP + 1 }, (_, i) => `t${i}`),
      ),
    ).toMatch(/Too many/)
  })

  it("rejects stacked/leading quantifiers (Python-divergent patterns)", () => {
    // v*+ etc. compile as POSSESSIVE quantifiers in Python (and match!)
    // while Go/JS throw — the one construct where the four matcher copies
    // would diverge, so writers refuse it (mirrors Go ValidateSubmissionTags).
    for (const p of ["v*+", "a++", "x?+", "m**+", "+lead", "?lead"]) {
      expect(validateSubmissionTags([p])).toMatch(/can't start|follow another/)
    }
  })
})

describe("safeShimTagPatterns — render-time fail-closed gate", () => {
  it("passes safe lists through and fails closed all-or-nothing", () => {
    // Mirrors Go contract.ShimTagsList: the shim writers consume the
    // PUBLISHED (hand-editable) manifest, so one unsafe pattern drops the
    // whole milestone set rather than rendering a partial/hostile tags line.
    expect(safeShimTagPatterns(undefined)).toEqual([])
    expect(safeShimTagPatterns(["phase1", "v*"])).toEqual(["phase1", "v*"])
    expect(safeShimTagPatterns(["v*+"])).toEqual([])
    expect(safeShimTagPatterns(["phase1", 'ta"g'])).toEqual([])
    expect(safeShimTagPatterns(["phase1", "a++"])).toEqual([])
    expect(
      safeShimTagPatterns(
        Array.from({ length: SUBMISSION_TAGS_CAP + 1 }, (_, i) => `t${i}`),
      ),
    ).toEqual([])
  })
})
