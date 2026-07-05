import { describe, expect, it } from "vitest"
import { aggregateOrgMembers, type ClassroomRoster } from "./orgMembers"
import type { Student } from "@/types/classroom"
import type { GitHubUser } from "@/hooks/github/types"

const member = (id: number, login: string, name?: string): GitHubUser =>
  ({
    id,
    login,
    name: name ?? null,
    avatar_url: `https://x/${login}`,
  }) as GitHubUser

const student = (over: Partial<Student>): Student => ({
  username: "",
  first_name: "",
  last_name: "",
  email: "",
  section: "",
  github_id: "",
  ...over,
})

const roster = (
  classroom: string,
  students: Student[],
  archived = false,
): ClassroomRoster => ({ classroom, archived, students })

describe("aggregateOrgMembers", () => {
  it("dedupes a student across two rosters into one row listing both classrooms", () => {
    const alice = student({
      username: "alice",
      github_id: "42",
      first_name: "Alice",
      section: "P1",
    })
    const rows = aggregateOrgMembers(
      [member(42, "alice")],
      [
        roster("cs101", [alice]),
        roster("cs201", [{ ...alice, section: "P2" }]),
      ],
    )
    const aliceRow = rows.find((r) => r.github_id === "42")
    expect(aliceRow?.classrooms.map((c) => c.classroom).sort()).toEqual([
      "cs101",
      "cs201",
    ])
    expect(aliceRow?.classrooms.map((c) => c.section).sort()).toEqual([
      "P1",
      "P2",
    ])
  })

  it("classifies a roster student as member when their github_id is a live member", () => {
    const rows = aggregateOrgMembers(
      [member(42, "alice")],
      [roster("cs101", [student({ username: "alice", github_id: "42" })])],
    )
    expect(rows[0].classification).toBe("member-on-roster")
    expect(rows[0].isMember).toBe(true)
  })

  it("flags a roster student who is NOT an org member as a discrepancy", () => {
    const rows = aggregateOrgMembers(
      [], // no members
      [roster("cs101", [student({ username: "bob", github_id: "43" })])],
    )
    expect(rows[0].classification).toBe("on-roster-not-member")
    expect(rows[0].isMember).toBe(false)
  })

  it("flags an org member on no roster as member-no-roster", () => {
    const rows = aggregateOrgMembers([member(99, "teacher", "Teach")], [])
    expect(rows).toHaveLength(1)
    expect(rows[0].classification).toBe("member-no-roster")
    expect(rows[0].username).toBe("teacher")
  })

  it("dedupes an email-only student by email and marks them not-a-member", () => {
    const rows = aggregateOrgMembers(
      [],
      [
        roster("cs101", [student({ email: "x@x.edu" })]),
        roster("cs201", [student({ email: "x@x.edu", section: "P3" })]),
      ],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].classification).toBe("on-roster-not-member")
    expect(rows[0].classrooms).toHaveLength(2)
  })

  it("aggregates archived classrooms and marks their access archived", () => {
    const rows = aggregateOrgMembers(
      [member(42, "alice")],
      [
        roster(
          "cs-old",
          [student({ username: "alice", github_id: "42" })],
          true,
        ),
      ],
    )
    expect(rows[0].classrooms[0].archived).toBe(true)
  })

  it("retains distinct classroom entries when the same student differs by section", () => {
    const rows = aggregateOrgMembers(
      [member(42, "alice")],
      [
        roster("cs101", [
          student({ username: "alice", github_id: "42", section: "P1" }),
        ]),
        roster("cs102", [
          student({ username: "alice", github_id: "42", section: "P9" }),
        ]),
      ],
    )
    const sections = rows[0].classrooms.map((c) => c.section).sort()
    expect(sections).toEqual(["P1", "P9"])
  })

  it("matches an empty-github_id roster row to a member by login (no duplicate row)", () => {
    // A roster row typed before reconcile has a username but no github_id. Must
    // be member-on-roster and NOT also surface as a separate member-no-roster.
    const rows = aggregateOrgMembers(
      [member(42, "alice")],
      [roster("cs101", [student({ username: "alice", github_id: "" })])],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].classification).toBe("member-on-roster")
    expect(rows[0].isMember).toBe(true)
    // The immutable id is backfilled from the member match.
    expect(rows[0].github_id).toBe("42")
  })

  it("matches a STALE-github_id roster row to a member by login and prefers the live id", () => {
    // CSV carries a stale github_id ("999") that matches no member, but the
    // username still matches a live member. The row must be member-on-roster,
    // not duplicated, and surface the LIVE id (42) so id-keyed display/actions
    // don't use "999".
    const rows = aggregateOrgMembers(
      [member(42, "alice")],
      [roster("cs101", [student({ username: "alice", github_id: "999" })])],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].classification).toBe("member-on-roster")
    expect(rows[0].isMember).toBe(true)
    expect(rows[0].github_id).toBe("42")
  })

  it("sorts discrepancies before members", () => {
    const rows = aggregateOrgMembers(
      [member(42, "alice")],
      [
        roster("cs101", [student({ username: "alice", github_id: "42" })]),
        roster("cs101", [student({ username: "bob", github_id: "43" })]),
      ],
    )
    expect(rows[0].classification).toBe("on-roster-not-member")
  })
})

describe("aggregateOrgMembers — team-verified membership / unprovisioned", () => {
  it("marks a member on the team as enrolled with nothing unprovisioned", () => {
    const rows = aggregateOrgMembers(
      [member(42, "alice")],
      [roster("cs101", [student({ username: "alice", github_id: "42" })])],
      new Map([["cs101", new Set(["42"])]]),
    )
    expect(rows[0].classrooms[0].state).toBe("enrolled")
    expect(rows[0].unprovisionedClassrooms).toEqual([])
  })

  it("flags a member on the CSV roster but NOT the team as unprovisioned", () => {
    const rows = aggregateOrgMembers(
      [member(42, "alice")],
      [roster("cs101", [student({ username: "alice", github_id: "42" })])],
      // team data present for cs101, but alice's id is not in it.
      new Map([["cs101", new Set<string>()]]),
    )
    expect(rows[0].classrooms[0].state).toBe("unprovisioned")
    expect(rows[0].unprovisionedClassrooms).toEqual(["cs101"])
  })

  it("treats a classroom with no team data as unknown (enrolled, never flagged)", () => {
    const rows = aggregateOrgMembers(
      [member(42, "alice")],
      [roster("cs101", [student({ username: "alice", github_id: "42" })])],
      new Map(), // no entry for cs101
    )
    expect(rows[0].classrooms[0].state).toBe("enrolled")
    expect(rows[0].unprovisionedClassrooms).toEqual([])
  })

  it("does not flag an archived classroom (its team may be gone)", () => {
    const rows = aggregateOrgMembers(
      [member(42, "alice")],
      [
        roster(
          "cs-old",
          [student({ username: "alice", github_id: "42" })],
          true,
        ),
      ],
      new Map([["cs-old", new Set<string>()]]),
    )
    expect(rows[0].unprovisionedClassrooms).toEqual([])
  })

  it("does not flag a non-member (already on-roster-not-member)", () => {
    const rows = aggregateOrgMembers(
      [], // not a member
      [roster("cs101", [student({ username: "bob", github_id: "43" })])],
      new Map([["cs101", new Set<string>()]]),
    )
    expect(rows[0].classification).toBe("on-roster-not-member")
    expect(rows[0].unprovisionedClassrooms).toEqual([])
  })

  it("flags only the classroom the member is missing from", () => {
    const rows = aggregateOrgMembers(
      [member(42, "alice")],
      [
        roster("cs101", [student({ username: "alice", github_id: "42" })]),
        roster("cs201", [student({ username: "alice", github_id: "42" })]),
      ],
      new Map([
        ["cs101", new Set(["42"])], // on team
        ["cs201", new Set<string>()], // unprovisioned
      ]),
    )
    expect(rows[0].unprovisionedClassrooms).toEqual(["cs201"])
    const cs201 = rows[0].classrooms.find((c) => c.classroom === "cs201")
    expect(cs201?.state).toBe("unprovisioned")
  })
})
