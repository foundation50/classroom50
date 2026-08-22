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

  it("exposes the preserved autograded score beneath an override", () => {
    // The override record leads; the real autograder submission is retained
    // beneath it. bucketToRows surfaces that real score/max as the value the
    // override reverts to when cleared.
    const normalized = normalizeScores(
      scoresWith([
        {
          owner: "alice",
          override: true,
          submissions: [
            overrideRecord,
            {
              ...overrideRecord,
              submission: "submit/2026-01-01T00-00-00Z-abc1234",
              datetime: "2026-01-01T00:00:00Z",
              score: 30,
              "max-score": 50,
            },
          ],
        },
      ]) as never,
    )
    const rows = normalized?.submissions.hw1 ?? []
    // Effective (displayed) grade is the override.
    expect(rows[0].score).toBe(42)
    // Preserved autograded value the clear reverts to.
    expect(rows[0].autogradedScore).toBe(30)
    expect(rows[0].autogradedMax).toBe(50)
  })

  it("omits the autograded score when an override has no real history", () => {
    const normalized = normalizeScores(
      scoresWith([
        { owner: "alice", override: true, submissions: [overrideRecord] },
      ]) as never,
    )
    const rows = normalized?.submissions.hw1 ?? []
    expect(rows[0].autogradedScore).toBeUndefined()
    expect(rows[0].autogradedMax).toBeUndefined()
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
    // A non-overridden entry never exposes the autograded-revert fields.
    expect(rows[0].autogradedScore).toBeUndefined()
  })
})

describe("normalizeScores — per-bucket collected_at", () => {
  it("surfaces a bucket's collected_at and omits unstamped buckets", () => {
    const normalized = normalizeScores({
      schema: "classroom50/scores/v1",
      assignments: {
        stamped: {
          type: "individual",
          entries: [],
          collected_at: "2026-06-01T15:00:00Z",
        },
        legacy: { type: "individual", entries: [] },
      },
    } as never)
    expect(normalized?.collectedAt).toEqual({
      stamped: "2026-06-01T15:00:00Z",
    })
  })

  it("ignores a non-string or empty collected_at", () => {
    const normalized = normalizeScores({
      schema: "classroom50/scores/v1",
      assignments: {
        bad: { type: "individual", entries: [], collected_at: 12345 },
        blank: { type: "individual", entries: [], collected_at: "" },
      },
    } as never)
    expect(normalized?.collectedAt).toEqual({})
  })
})

describe("normalizeScores — detected (ungraded) submissions", () => {
  it("surfaces a bucket's detected submitters", () => {
    const normalized = normalizeScores({
      schema: "classroom50/scores/v1",
      assignments: {
        manual: {
          type: "individual",
          entries: [],
          detected: [
            {
              owner: "alice",
              count: 3,
              kind: "commit",
              latest_datetime: "2026-06-02T10:00:00Z",
              late: true,
            },
          ],
        },
      },
    } as never)
    expect(normalized?.detected.manual).toEqual([
      {
        owner: "alice",
        usernames: ["alice"],
        count: 3,
        datetime: "2026-06-02T10:00:00Z",
        late: true,
      },
    ])
    // A detected assignment produces no graded rows.
    expect(normalized?.submissions.manual).toEqual([])
  })

  it("distinguishes never-collected from collected-with-nobody", () => {
    // The absent key must not read as an empty list: 0/N for a bucket that was
    // never walked is exactly the bug this fixes (#659).
    const normalized = normalizeScores({
      schema: "classroom50/scores/v1",
      assignments: {
        walked: { type: "individual", entries: [], detected: [] },
        never: { type: "individual", entries: [] },
      },
    } as never)
    expect(normalized?.detected.walked).toEqual([])
    expect(normalized?.detected.never).toBeUndefined()
  })

  it("credits group members when present", () => {
    const normalized = normalizeScores({
      schema: "classroom50/scores/v1",
      assignments: {
        team: {
          type: "group",
          entries: [],
          detected: [
            { owner: "team-1", count: 1, member_usernames: ["alice", "bob"] },
          ],
        },
      },
    } as never)
    expect(normalized?.detected.team[0].usernames).toEqual(["alice", "bob"])
  })

  it("drops malformed or zero-count records", () => {
    const normalized = normalizeScores({
      schema: "classroom50/scores/v1",
      assignments: {
        manual: {
          type: "individual",
          entries: [],
          detected: [
            { owner: "alice", count: 1 },
            { owner: "", count: 2 },
            { owner: "bob", count: 0 },
            { owner: "carol" },
            { count: 5 },
          ],
        },
      },
    } as never)
    expect(normalized?.detected.manual.map((d) => d.owner)).toEqual(["alice"])
  })
})
