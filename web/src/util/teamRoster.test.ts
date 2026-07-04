import { describe, expect, it } from "vitest"
import { buildTeamRoster, countByState, rowToStudent } from "./teamRoster"
import type { Student } from "@/types/classroom"
import type { GitHubUser, GitHubOrgInvitation } from "@/hooks/github/types"

const member = (id: number, login: string, over: Partial<GitHubUser> = {}) =>
  ({
    id,
    login,
    avatar_url: `https://avatars/${login}`,
    html_url: "",
    name: null,
    email: null,
    bio: null,
    permissions: { admin: false, pull: true, maintain: false, push: false },
    ...over,
  }) as GitHubUser

const invite = (over: Partial<GitHubOrgInvitation>): GitHubOrgInvitation =>
  ({
    id: 1,
    login: null,
    email: null,
    role: "direct_member",
    created_at: "",
    failed_at: null,
    failed_reason: null,
    ...over,
  }) as GitHubOrgInvitation

const csvRow = (over: Partial<Student>): Student =>
  ({
    username: "",
    first_name: "",
    last_name: "",
    email: "",
    section: "",
    github_id: "",
    ...over,
  }) as Student

describe("buildTeamRoster", () => {
  it("marks team members as enrolled and enriches from the CSV by github_id", () => {
    const rows = buildTeamRoster({
      members: [member(101, "ada")],
      students: [
        csvRow({
          github_id: "101",
          username: "ada",
          first_name: "Ada",
          last_name: "Lovelace",
          section: "A",
          email: "ada@uni.edu",
        }),
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      state: "enrolled",
      username: "ada",
      github_id: "101",
      first_name: "Ada",
      last_name: "Lovelace",
      section: "A",
    })
  })

  it("renders a member with blank metadata when the CSV is missing them", () => {
    const rows = buildTeamRoster({
      members: [member(7, "grace")],
      students: [],
    })
    expect(rows[0]).toMatchObject({
      state: "enrolled",
      username: "grace",
      github_id: "7",
      first_name: "",
      last_name: "",
      email: "",
    })
  })

  it("joins CSV by login when the CSV row has no github_id (no drift, no dup)", () => {
    // Pre-resolution CSV row: username only, empty github_id. Must be treated as
    // the SAME person as the member, not counted as drift + member twice.
    const rows = buildTeamRoster({
      members: [member(55, "linus")],
      students: [csvRow({ username: "Linus", first_name: "Linus" })],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: "enrolled", first_name: "Linus" })
  })

  it("marks pending invitations as pending", () => {
    const rows = buildTeamRoster({
      members: [],
      invitations: [invite({ id: 2, login: "pendinguser" })],
      students: [],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: "pending", username: "pendinguser" })
    // The pending row MUST carry the org-invitation id: resendOrgInvitation
    // short-circuits (re-sends nothing) without it, so dropping it is a silent
    // no-op, not a crash. Pin it here so a regression fails loudly.
    expect(rows[0].invitation_id).toBe(2)
  })

  it("leaves invitation_id undefined for enrolled (non-pending) rows", () => {
    const rows = buildTeamRoster({
      members: [member(55, "linus")],
      invitations: [],
      students: [],
    })
    expect(rows[0].state).toBe("enrolled")
    expect(rows[0].invitation_id).toBeUndefined()
  })

  it("skips a pending invite for someone already an active member", () => {
    const rows = buildTeamRoster({
      members: [member(101, "ada")],
      invitations: [invite({ id: 2, login: "ada" })],
      students: [],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe("enrolled")
  })

  it("joins an email-only invite to CSV metadata by email", () => {
    const rows = buildTeamRoster({
      members: [],
      invitations: [invite({ id: 3, email: "bob@uni.edu" })],
      students: [
        csvRow({ email: "bob@uni.edu", first_name: "Bob", section: "B" }),
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      state: "pending",
      first_name: "Bob",
      section: "B",
    })
    expect(rows[0].invitation_id).toBe(3)
  })

  it("marks CSV-only rows with no member/invite as unprovisioned", () => {
    const rows = buildTeamRoster({
      members: [member(101, "ada")],
      invitations: [],
      students: [
        csvRow({ github_id: "101", username: "ada" }),
        csvRow({ username: "ghost", first_name: "Ghost" }),
      ],
    })
    const ghost = rows.find((r) => r.username === "ghost")
    expect(ghost?.state).toBe("unprovisioned")
    expect(rows.filter((r) => r.state === "enrolled")).toHaveLength(1)
  })

  it("does not emit a member as both enrolled and unprovisioned", () => {
    const rows = buildTeamRoster({
      members: [member(101, "ada")],
      students: [csvRow({ github_id: "101", username: "ada" })],
    })
    expect(rows.filter((r) => r.username === "ada")).toHaveLength(1)
  })

  it("dedupes duplicate CSV-only rows for the same person", () => {
    const rows = buildTeamRoster({
      members: [],
      students: [
        csvRow({ email: "dup@uni.edu", first_name: "Dup" }),
        csvRow({ email: "dup@uni.edu", last_name: "Licate" }),
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe("unprovisioned")
  })

  it("sorts enrolled, then pending, then unprovisioned", () => {
    const rows = buildTeamRoster({
      members: [member(2, "zed")],
      invitations: [invite({ id: 9, login: "pat" })],
      students: [csvRow({ username: "wanda" })],
    })
    expect(rows.map((r) => r.state)).toEqual([
      "enrolled",
      "pending",
      "unprovisioned",
    ])
  })

  it("counts rows by state for the banner", () => {
    const rows = buildTeamRoster({
      members: [member(1, "a"), member(2, "b")],
      invitations: [invite({ id: 9, login: "c" })],
      students: [csvRow({ username: "d" }), csvRow({ username: "e" })],
    })
    expect(countByState(rows)).toEqual({
      enrolled: 2,
      pending: 1,
      unprovisioned: 2,
    })
  })

  it("rowToStudent projects all six Student fields from a roster row", () => {
    const rows = buildTeamRoster({
      members: [member(101, "ada")],
      students: [
        csvRow({
          github_id: "101",
          username: "ada",
          first_name: "Ada",
          last_name: "Lovelace",
          email: "ada@uni.edu",
          section: "A",
        }),
      ],
    })
    expect(rowToStudent(rows[0])).toEqual({
      username: "ada",
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@uni.edu",
      section: "A",
      github_id: "101",
    })
  })
})
