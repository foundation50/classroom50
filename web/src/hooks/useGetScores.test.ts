import { describe, expect, it } from "vitest"

import { normalizeScores } from "./useGetScores"

// A scores.json shape with one assignment bucket. Kept minimal to the fields
// bucketToRows reads.
function scoresWith(entries: unknown[]) {
  return {
    schema: "classroom50/scores/v1",
    assignments: {
      hw1: { type: "individual", entries },
    },
  }
}

const overrideRecord = {
  schema: "classroom50/result/v1",
  classroom: "cs50",
  assignment_type: "individual",
  owner: "alice",
  submission: "submit/manual-2026-02-02T00-00-00Z",
  commit: "submit/manual-2026-02-02T00-00-00Z",
  release: "submit/manual-2026-02-02T00-00-00Z",
  review: "submit/manual-2026-02-02T00-00-00Z",
  datetime: "2026-02-02T00:00:00Z",
  score: 42,
  "max-score": 50,
  tests: [],
}

describe("normalizeScores — manual override entries", () => {
  it("renders a synthesized override entry as a normal graded row", () => {
    // A manual/override entry carries a real submissions[0] in the existing
    // shape, so the reader surfaces its score/max-score with no special branch.
    const normalized = normalizeScores(
      scoresWith([
        { owner: "alice", override: true, submissions: [overrideRecord] },
      ]) as never,
    )
    const rows = normalized?.submissions.hw1 ?? []
    expect(rows).toHaveLength(1)
    expect(rows[0].owner).toBe("alice")
    expect(rows[0].score).toBe(42)
    expect(rows[0]["max-score"]).toBe(50)
    // The override flag is surfaced so the table can mark it.
    expect(rows[0].overridden).toBe(true)
  })

  it("leaves overridden false for a plain autograded entry", () => {
    const normalized = normalizeScores(
      scoresWith([
        {
          owner: "bob",
          submissions: [
            {
              ...overrideRecord,
              owner: "bob",
              submission: "submit/2026-01-01T00-00-00Z-abc1234",
            },
          ],
        },
      ]) as never,
    )
    const rows = normalized?.submissions.hw1 ?? []
    expect(rows[0].overridden).toBe(false)
  })
})
