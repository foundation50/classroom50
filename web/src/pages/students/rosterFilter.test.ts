import { describe, expect, it } from "vitest"
import {
  filterRosterRows,
  NO_SECTION,
  type RosterFilterInput,
} from "./rosterFilter"
import type {
  ClassroomRole,
  TeamRosterRow,
  TeamRosterRowState,
} from "@/util/teamRoster"

const row = (
  over: Partial<TeamRosterRow> & { roles: ClassroomRole[] },
): TeamRosterRow =>
  ({
    key: over.username ?? "k",
    state: "enrolled",
    username: "",
    github_id: "",
    first_name: "",
    last_name: "",
    section: "",
    email: "",
    avatar_url: "",
    ...over,
  }) as TeamRosterRow

const base: RosterFilterInput = {
  query: "",
  statusFilter: "all",
  roleFilter: "all",
  sectionFilter: "all",
}

describe("filterRosterRows", () => {
  const rows: TeamRosterRow[] = [
    row({ username: "stu", roles: ["student"], state: "enrolled" }),
    row({
      username: "prof",
      roles: ["instructor", "student"],
      state: "enrolled",
    }),
    row({
      username: "tessa",
      roles: ["ta"],
      state: "pending" as TeamRosterRowState,
    }),
  ]

  it("role filter 'ta' keeps only rows including ta", () => {
    const out = filterRosterRows(rows, { ...base, roleFilter: "ta" })
    expect(out.map((r) => r.username)).toEqual(["tessa"])
  })

  it("a multi-role person appears under each of their roles", () => {
    expect(
      filterRosterRows(rows, { ...base, roleFilter: "instructor" }).map(
        (r) => r.username,
      ),
    ).toEqual(["prof"])
    expect(
      filterRosterRows(rows, { ...base, roleFilter: "student" }).map(
        (r) => r.username,
      ),
    ).toEqual(["stu", "prof"])
  })

  it("role and status filters AND together", () => {
    // ta row is pending; filtering role=ta + status=enrolled yields nothing.
    expect(
      filterRosterRows(rows, {
        ...base,
        roleFilter: "ta",
        statusFilter: "enrolled",
      }),
    ).toEqual([])
  })

  it("section filter matches the No section bucket for blank sections", () => {
    expect(
      filterRosterRows(rows, { ...base, sectionFilter: NO_SECTION }).length,
    ).toBe(3)
  })

  it("text query matches username", () => {
    expect(
      filterRosterRows(rows, { ...base, query: "prof" }).map((r) => r.username),
    ).toEqual(["prof"])
  })
})
