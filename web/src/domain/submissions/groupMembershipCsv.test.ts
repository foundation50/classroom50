import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import type { GroupTeamRef } from "@/domain/teams/groupTeams"
import type { GitHubUser } from "@/github-core/types"
import type { Student } from "@/types/classroom"
import { groupExportName } from "@/util/groupTeam"
import {
  GROUP_MEMBERSHIP_CSV_COLUMNS,
  GROUP_MEMBERSHIP_NOTE_UNREADABLE,
  buildGroupMembershipCsvRows,
  downloadGroupsDisabledReason,
  groupMembershipSources,
  naturalCompare,
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

describe("naturalCompare", () => {
  it("orders digit runs numerically, ignoring leading zeros and case", () => {
    const sorted = [
      "group-10",
      "Group-2",
      "group-01",
      "a10",
      "a9",
      "b",
    ].toSorted(naturalCompare)
    expect(sorted).toEqual([
      "a9",
      "a10",
      "b",
      "group-01",
      "Group-2",
      "group-10",
    ])
    expect(naturalCompare("group-01", "group-1")).toBe(0)
  })

  it("compares code points, not locale order", () => {
    expect(naturalCompare("f-oo", "f_oo")).toBeLessThan(0)
    expect(naturalCompare("zed", "éclair")).toBeLessThan(0)
  })
})

const user = (login: string, id: number): GitHubUser =>
  ({ login, id }) as GitHubUser
const team = (n: number, name?: string): GroupTeamRef => ({
  slug: `classroom50-group-abcdef0123456789-${n}`,
  id: 500 + n,
  n,
  name,
})

describe("groupMembershipSources", () => {
  it("lists every live team with its repo and id-bearing members", () => {
    const t1 = team(1, "The Sharks")
    const t2 = team(2)
    const sources = groupMembershipSources({
      isTeamAssignment: true,
      teamByOwner: new Map([
        ["group-1", t1],
        ["group-2", t2],
      ]),
      teamMembersBySlug: new Map([[t1.slug, [user("alice", 1)]]]),
      groupRepoList: [{ owner: "group-1", repoName: "cs-hw1-group-1" }],
      groupCollabByRepo: new Map(),
    })
    expect(sources).toEqual([
      {
        group: "group-1",
        name: "The Sharks",
        teamSlug: t1.slug,
        repoName: "cs-hw1-group-1",
        members: [{ login: "alice", id: 1 }],
      },
      // No repo yet, and no member read for this slug: unreadable, not empty.
      {
        group: "group-2",
        name: "Group 2",
        teamSlug: t2.slug,
        repoName: undefined,
        members: undefined,
      },
    ])
  })

  it("lists every legacy repo with its collaborators and the founder as a fallback", () => {
    const sources = groupMembershipSources({
      isTeamAssignment: false,
      teamByOwner: new Map(),
      teamMembersBySlug: new Map(),
      groupRepoList: [
        { owner: "alice", repoName: "cs-hw1-alice" },
        { owner: "bob", repoName: "cs-hw1-bob" },
      ],
      groupCollabByRepo: new Map([
        ["cs-hw1-alice", [user("ada-lovelace", 1), user("Carol", 3)]],
      ]),
    })
    expect(sources).toEqual([
      {
        group: "alice",
        repoName: "cs-hw1-alice",
        members: [
          { login: "ada-lovelace", id: 1 },
          { login: "Carol", id: 3 },
          { login: "alice", fallback: true },
        ],
      },
      // Collaborator read failed: unreadable, not empty.
      { group: "bob", repoName: "cs-hw1-bob", members: undefined },
    ])
  })
})

describe("downloadGroupsDisabledReason", () => {
  it("reports loading before unavailable before empty", () => {
    expect(
      downloadGroupsDisabledReason({
        loading: true,
        unavailable: true,
        sourceCount: 0,
      }),
    ).toBe("loading")
    expect(
      downloadGroupsDisabledReason({
        loading: false,
        unavailable: true,
        sourceCount: 0,
      }),
    ).toBe("unavailable")
    expect(
      downloadGroupsDisabledReason({
        loading: false,
        unavailable: false,
        sourceCount: 0,
      }),
    ).toBe("empty")
    expect(
      downloadGroupsDisabledReason({
        loading: false,
        unavailable: false,
        sourceCount: 2,
      }),
    ).toBeUndefined()
  })
})
