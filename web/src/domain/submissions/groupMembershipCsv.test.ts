import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import type { Student } from "@/types/classroom"
import { groupExportName } from "@/util/groupTeam"
import {
  GROUP_MEMBERSHIP_CSV_COLUMNS,
  GROUP_MEMBERSHIP_NOTE_UNREADABLE,
  buildGroupMembershipCsvRows,
  type GroupMember,
} from "./groupMembershipCsv"

// The shared cases are the cross-language oracle: the Go suite
// (cli/gh-teacher/internal/groupcmd) asserts the same file, so a one-sided
// change to the join, dedupe, ordering, escaping, or default name fails on
// the other language's copy.
const fixtureUrl = new URL(
  "../../../../cli/shared/testdata/group_membership_cases.json",
  import.meta.url,
)
const doc = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf8")) as {
  columns: string[]
  note_unreadable: string
  default_name: { recorded: string; counter: number; name: string }[]
  cases: {
    name: string
    roster: Student[]
    groups: {
      group: string
      name: string
      team_slug: string
      repo: string
      members: GroupMember[] | null
    }[]
    rows: string[][]
  }[]
}

describe("buildGroupMembershipCsvRows (shared cases)", () => {
  it("pins the column contract and the unreadable note", () => {
    expect(doc.columns).toEqual([...GROUP_MEMBERSHIP_CSV_COLUMNS])
    expect(doc.note_unreadable).toBe(GROUP_MEMBERSHIP_NOTE_UNREADABLE)
  })

  it("pins the untranslated default name for an unnamed team", () => {
    for (const d of doc.default_name) {
      expect(
        groupExportName({ name: d.recorded || undefined, n: d.counter }),
      ).toBe(d.name)
    }
  })

  for (const c of doc.cases) {
    it(c.name, () => {
      const rows = buildGroupMembershipCsvRows(
        c.groups.map((g) => ({
          group: g.group,
          name: g.name || undefined,
          teamSlug: g.team_slug || undefined,
          repoName: g.repo || undefined,
          members: g.members ?? undefined,
        })),
        c.roster,
      )
      // Every row carries every column, in contract order.
      for (const row of rows) {
        expect(Object.keys(row)).toEqual([...GROUP_MEMBERSHIP_CSV_COLUMNS])
      }
      expect(
        rows.map((row) => GROUP_MEMBERSHIP_CSV_COLUMNS.map((col) => row[col])),
      ).toEqual(c.rows)
    })
  }
})

describe("buildGroupMembershipCsvRows (web-only cases)", () => {
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

  it("trims whitespace on both sides of the join and skips a blank login", () => {
    const rows = buildGroupMembershipCsvRows(
      [{ group: "group-1", members: [{ login: " alice " }, { login: "  " }] }],
      [student(" alice ", " Alice ", " Ada ", { github_id: " 1 " })],
    )
    expect(rows).toEqual([
      expect.objectContaining({
        username: "alice",
        first_name: "Alice",
        last_name: "Ada",
        github_id: "1",
        in_roster: "yes",
      }),
    ])
  })

  it("keeps the first roster row when two rows share a username or github_id", () => {
    const rows = buildGroupMembershipCsvRows(
      [{ group: "group-1", members: [{ login: "alice", id: 1 }] }],
      [
        student("alice", "Alice", "Ada", { github_id: "1" }),
        student("ALICE", "Dup", "Row", { github_id: "1" }),
      ],
    )
    expect(rows.map((r) => r.last_name)).toEqual(["Ada"])
  })
})
