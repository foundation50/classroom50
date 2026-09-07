import { describe, expect, it } from "vitest"

import {
  emptyTeamsFile,
  removeTeamFromSnapshot,
  snapshotDrift,
  upsertAssignmentTeams,
  TEAMS_SCHEMA_V1,
  type TeamsFile,
  type TeamsFileTeam,
} from "./teamsFile"

const team = (slug: string, members: string[]): TeamsFileTeam => ({
  slug,
  id: 1,
  members,
  formation: "teacher",
})

describe("upsertAssignmentTeams", () => {
  it("replaces one assignment's teams and preserves unknown fields", () => {
    const file = {
      schema: TEAMS_SCHEMA_V1,
      future_field: "kept",
      assignments: {
        hw1: { teams: [team("a", ["alice"])], bucket_extra: 7 },
        hw2: { teams: [team("b", ["bob"])] },
      },
    } as unknown as TeamsFile

    const next = upsertAssignmentTeams(file, "hw1", [team("c", ["carol"])])

    // Unknown top-level and bucket-level fields ride through (additive
    // evolution: a newer release may have written them).
    expect((next as Record<string, unknown>).future_field).toBe("kept")
    expect((next.assignments.hw1 as Record<string, unknown>).bucket_extra).toBe(
      7,
    )
    // The team list is snapshot-replaced wholesale.
    expect(next.assignments.hw1.teams).toEqual([team("c", ["carol"])])
    // Sibling buckets untouched.
    expect(next.assignments.hw2.teams).toEqual([team("b", ["bob"])])
  })

  it("creates the bucket when absent", () => {
    const next = upsertAssignmentTeams(emptyTeamsFile(), "hw1", [team("a", [])])
    expect(next.assignments.hw1.teams).toEqual([team("a", [])])
  })
})

describe("removeTeamFromSnapshot", () => {
  it("drops one team and no-ops on a missing bucket", () => {
    const file = upsertAssignmentTeams(emptyTeamsFile(), "hw1", [
      team("a", []),
      team("b", []),
    ])
    const next = removeTeamFromSnapshot(file, "hw1", "a")
    expect(next.assignments.hw1.teams.map((t) => t.slug)).toEqual(["b"])
    expect(removeTeamFromSnapshot(file, "hw9", "a")).toBe(file)
  })
})

describe("snapshotDrift", () => {
  const live = new Map<string, { login: string }[]>([
    ["a", [{ login: "Alice" }, { login: "bob" }]],
    ["b", [{ login: "carol" }]],
    ["c", [{ login: "dave" }]],
  ])

  it("flags changed membership (order- and case-insensitive match)", () => {
    const snapshot = [
      team("a", ["BOB", "alice"]), // same set, different order/case: no drift
      team("b", ["carol", "eve"]), // eve left: drift
    ]
    const { changed, missing } = snapshotDrift(snapshot, live)
    expect(changed).toEqual(new Set(["b"]))
    // Live team `c` isn't in the snapshot at all.
    expect(missing).toEqual(new Set(["c"]))
  })

  it("an absent snapshot marks every live team missing", () => {
    const { changed, missing } = snapshotDrift(undefined, live)
    expect(changed.size).toBe(0)
    expect(missing).toEqual(new Set(["a", "b", "c"]))
  })
})
