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
      roles: ["teacher", "student"],
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
      filterRosterRows(rows, { ...base, roleFilter: "teacher" }).map(
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

  // Expired rows keep their state, so they appear under BOTH the state filter
  // and the cross-state "Invitation expired" option.
  it("'invite_expired' gathers expired rows across states; state filters still include them", () => {
    const expired = (over: Partial<TeamRosterRow>) =>
      row({
        roles: ["student"],
        failed_invitation: {
          id: 1,
          kind: "expired",
          failed_at: null,
          reason: null,
        },
        ...over,
      })
    const mixed: TeamRosterRow[] = [
      expired({ key: "e1", email: "e1@x.edu", state: "unlinked" }),
      expired({
        key: "e2",
        username: "mona",
        state: "needs_attention_not_in_org",
      }),
      row({
        key: "u",
        email: "u@x.edu",
        roles: ["student"],
        state: "unlinked",
      }),
      row({
        key: "b",
        email: "b@x.edu",
        roles: ["student"],
        state: "unlinked",
        failed_invitation: {
          id: 2,
          kind: "failed",
          failed_at: null,
          reason: "Email bounced",
        },
      }),
    ]
    const keys = (f: RosterFilterInput["statusFilter"]) =>
      filterRosterRows(mixed, { ...base, statusFilter: f }).map((r) => r.key)

    expect(keys("invite_expired")).toEqual(["e1", "e2"])
    expect(keys("unlinked")).toEqual(["e1", "u", "b"])
    expect(keys("needs_attention_not_in_org")).toEqual(["e2"])
  })
})
