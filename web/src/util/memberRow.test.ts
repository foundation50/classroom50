import { describe, expect, it } from "vitest"

import { orgRowToMemberRow, rosterRowToMemberRow } from "./memberRow"
import type { OrgMemberRow } from "@/util/orgMembers"
import type { TeamRosterRow } from "@/util/teamRoster"

const rosterRow = (over: Partial<TeamRosterRow> = {}): TeamRosterRow => ({
  key: "1",
  state: "enrolled",
  username: "octocat",
  github_id: "1",
  first_name: "",
  last_name: "",
  section: "",
  email: "",
  avatar_url: "",
  ...over,
})

describe("rosterRowToMemberRow", () => {
  it("derives name from first/last parts", () => {
    const row = rosterRowToMemberRow(
      rosterRow({ first_name: "ada", last_name: "lovelace" }),
    )
    expect(row.name).toBe("Ada Lovelace")
    expect(row.key).toBe("1")
    expect(row.username).toBe("octocat")
  })

  it("falls back to username when no name parts", () => {
    expect(rosterRowToMemberRow(rosterRow()).name).toBe("octocat")
  })

  it("falls back to email when no name and no username", () => {
    const row = rosterRowToMemberRow(
      rosterRow({
        username: "",
        github_id: "",
        email: "a@x.edu",
        key: "a@x.edu",
      }),
    )
    expect(row.name).toBe("a@x.edu")
  })
})

describe("orgRowToMemberRow", () => {
  it("projects the display fields as-is", () => {
    const org: OrgMemberRow = {
      key: "9",
      username: "hubot",
      github_id: "9",
      name: "Hubot",
      email: "hubot@x.edu",
      isMember: true,
      classrooms: [],
      classification: "member-on-roster",
      unprovisionedClassrooms: [],
    }
    expect(orgRowToMemberRow(org)).toEqual({
      key: "9",
      username: "hubot",
      github_id: "9",
      name: "Hubot",
      email: "hubot@x.edu",
    })
  })
})
