import { describe, expect, it } from "vitest"

import type { Student } from "@/types/classroom"
import {
  GROUP_MEMBERSHIP_CSV_COLUMNS,
  GROUP_MEMBERSHIP_NOTE_UNREADABLE,
  buildGroupMembershipCsvRows,
} from "./groupMembershipCsv"

const student = (
  username: string,
  first: string,
  last: string,
  extra: Partial<Student> = {},
): Student => ({
  username,
  first_name: first,
  last_name: last,
  email: `${username}@x.edu`,
  section: "A",
  github_id: "",
  role: "student",
  ...extra,
})

// Live members by login only, as a legacy founder arrives.
const m = (...logins: string[]) => logins.map((login) => ({ login }))

const roster = [
  student("alice", "Alice", "Ada", { github_id: "1" }),
  student("bob", "Bob", "Babbage", { github_id: "2", section: "B" }),
  student("Cat", "Cat", "Curry", { role: "ta" }),
]

describe("buildGroupMembershipCsvRows", () => {
  it("pins the column contract shared with the CLI", () => {
    // The member block is exactly roster.csv's header so the file joins to the
    // roster; the whole row mirrors contract.GroupMembershipCSVColumns.
    expect(GROUP_MEMBERSHIP_CSV_COLUMNS.join(",")).toBe(
      "group,group_name,team_slug,repo,username,first_name,last_name,email,section,github_id,role,in_roster,note",
    )
    expect(GROUP_MEMBERSHIP_NOTE_UNREADABLE).toBe(
      "membership could not be read",
    )
  })

  it("emits one row per member with the roster join, team block filled", () => {
    const rows = buildGroupMembershipCsvRows(
      [
        {
          group: "group-1",
          name: "The Sharks",
          teamSlug: "classroom50-group-abcdef0123456789-1",
          repoName: "cs-hw1-group-1",
          members: m("bob", "alice"),
        },
      ],
      roster,
    )
    expect(rows).toEqual([
      {
        group: "group-1",
        group_name: "The Sharks",
        team_slug: "classroom50-group-abcdef0123456789-1",
        repo: "cs-hw1-group-1",
        username: "alice",
        first_name: "Alice",
        last_name: "Ada",
        email: "alice@x.edu",
        section: "A",
        github_id: "1",
        role: "student",
        in_roster: "yes",
        note: "",
      },
      {
        group: "group-1",
        group_name: "The Sharks",
        team_slug: "classroom50-group-abcdef0123456789-1",
        repo: "cs-hw1-group-1",
        username: "bob",
        first_name: "Bob",
        last_name: "Babbage",
        email: "bob@x.edu",
        section: "B",
        github_id: "2",
        role: "student",
        in_roster: "yes",
        note: "",
      },
    ])
    // Every row carries every column, in contract order.
    for (const row of rows) {
      expect(Object.keys(row)).toEqual([...GROUP_MEMBERSHIP_CSV_COLUMNS])
    }
  })

  it("leaves the team block blank for a legacy group and dedupes the founder", () => {
    // Legacy members are [founder, ...collaborators] and the founder is also a
    // direct collaborator, so the same login arrives twice (case may differ).
    const rows = buildGroupMembershipCsvRows(
      [
        {
          group: "alice",
          repoName: "cs-hw1-alice",
          members: m("alice", "Alice", "bob"),
        },
      ],
      roster,
    )
    expect(rows.map((r) => r.username)).toEqual(["alice", "bob"])
    expect(rows[0]).toMatchObject({
      group: "alice",
      group_name: "",
      team_slug: "",
      repo: "cs-hw1-alice",
    })
  })

  it("flags a member the roster does not know and uses the roster's login spelling", () => {
    const rows = buildGroupMembershipCsvRows(
      [{ group: "group-2", members: m("cat", "stranger") }],
      roster,
    )
    expect(rows).toEqual([
      expect.objectContaining({
        username: "Cat",
        last_name: "Curry",
        role: "ta",
        in_roster: "yes",
      }),
      expect.objectContaining({
        username: "stranger",
        first_name: "",
        last_name: "",
        email: "",
        section: "",
        github_id: "",
        role: "",
        in_roster: "no",
      }),
    ])
  })

  it("joins a renamed student by github_id and dedupes them against their founder login", () => {
    // alice renamed her GitHub account to "ada-l" after enrolling; the live
    // team read carries her id, the legacy founder segment still says "alice".
    const rows = buildGroupMembershipCsvRows(
      [
        {
          group: "alice",
          repoName: "cs-hw1-alice",
          members: [
            { login: "alice" },
            { login: "ada-l", id: 1 },
            { login: "bob", id: 2 },
          ],
        },
      ],
      roster,
    )
    expect(rows.map((r) => [r.username, r.github_id, r.in_roster])).toEqual([
      ["alice", "1", "yes"],
      ["bob", "2", "yes"],
    ])
  })

  it("keeps an empty group and an unreadable group visible as one blank-member row", () => {
    const rows = buildGroupMembershipCsvRows(
      [
        { group: "group-3", name: "Placeholder", members: [] },
        { group: "group-1", repoName: "cs-hw1-group-1", members: undefined },
      ],
      roster,
    )
    expect(rows).toEqual([
      expect.objectContaining({
        group: "group-1",
        username: "",
        in_roster: "",
        note: GROUP_MEMBERSHIP_NOTE_UNREADABLE,
      }),
      expect.objectContaining({
        group: "group-3",
        group_name: "Placeholder",
        username: "",
        in_roster: "",
        note: "",
      }),
    ])
  })

  it("orders groups naturally (group-2 before group-10) and members by last name", () => {
    const rows = buildGroupMembershipCsvRows(
      [
        { group: "group-10", members: m("alice") },
        { group: "group-2", members: m("bob", "alice") },
      ],
      roster,
    )
    expect(rows.map((r) => `${r.group}/${r.username}`)).toEqual([
      "group-2/alice",
      "group-2/bob",
      "group-10/alice",
    ])
  })

  it("neutralizes spreadsheet formulas in free-text cells but not github_id", () => {
    const rows = buildGroupMembershipCsvRows(
      [
        {
          group: "=cmd()",
          name: "+SUM(1)",
          teamSlug: "-slug",
          repoName: "@repo",
          members: m("=evil"),
        },
      ],
      [
        student("=evil", "=first", "-last", {
          email: "+e@x.edu",
          section: "@S",
          github_id: "42",
          role: "-role",
        }),
      ],
    )
    expect(rows[0]).toEqual({
      group: "'=cmd()",
      group_name: "'+SUM(1)",
      team_slug: "'-slug",
      repo: "'@repo",
      username: "'=evil",
      first_name: "'=first",
      last_name: "'-last",
      email: "'+e@x.edu",
      section: "'@S",
      github_id: "42",
      role: "'-role",
      in_roster: "yes",
      note: "",
    })
  })
})
