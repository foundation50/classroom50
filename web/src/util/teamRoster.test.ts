import { describe, expect, it } from "vitest"
import {
  buildTeamRoster,
  countByState,
  githubOrgRoleForRole,
  roleForGitHubOrgRole,
  rowToStudent,
  teamMembersMissingFromCsv,
  rowsNeedingBackfill,
} from "./teamRoster"
import { isOwnerGitHubOrgRole } from "@/util/roles"
import { enrolledCountsByRole } from "./rosterRoles"
import type { Student } from "@/types/classroom"
import { STAFF_ROLES } from "@/types/classroom"
import type { GitHubUser, GitHubOrgInvitation } from "@/github-core/types"

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
    // Pre-resolution CSV row: username only, empty github_id. Must be the SAME
    // person as the member, not counted as drift + member twice.
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
    // short-circuits without it (a silent no-op). Pin it so a regression fails.
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

  it("does NOT emit a row for a CSV person not on any team or invite", () => {
    const rows = buildTeamRoster({
      members: [member(101, "ada")],
      invitations: [],
      students: [
        csvRow({ github_id: "101", username: "ada" }),
        csvRow({ username: "ghost", first_name: "Ghost" }),
      ],
    })
    // ada is enrolled (on the team); ghost has only a CSV row -> no row.
    expect(rows.map((r) => r.username)).toEqual(["ada"])
    expect(rows.filter((r) => r.state === "enrolled")).toHaveLength(1)
  })

  it("does not emit a member twice", () => {
    const rows = buildTeamRoster({
      members: [member(101, "ada")],
      students: [csvRow({ github_id: "101", username: "ada" })],
    })
    expect(rows.filter((r) => r.username === "ada")).toHaveLength(1)
  })

  it("ignores legacy username-less CSV rows (no row emitted)", () => {
    const rows = buildTeamRoster({
      members: [],
      students: [csvRow({ email: "legacy@uni.edu", first_name: "Legacy" })],
    })
    expect(rows).toHaveLength(0)
  })

  it("enriches an enrolled row from its matching CSV row", () => {
    // roster.csv only enriches — the row exists because ada is on the team; the
    // CSV lends her name/section.
    const rows = buildTeamRoster({
      members: [member(101, "ada")],
      students: [
        csvRow({
          github_id: "101",
          username: "ada",
          first_name: "Ada",
          section: "C",
        }),
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      state: "enrolled",
      username: "ada",
      first_name: "Ada",
      section: "C",
    })
  })

  it("sorts enrolled, then pending", () => {
    const rows = buildTeamRoster({
      members: [member(2, "zed")],
      invitations: [invite({ id: 9, login: "pat" })],
      students: [csvRow({ username: "wanda" })],
    })
    // wanda is CSV-only (not on a team) -> not rendered.
    expect(rows.map((r) => r.state)).toEqual(["enrolled", "pending"])
  })

  it("counts rows by state for the banner", () => {
    const rows = buildTeamRoster({
      members: [member(1, "a"), member(2, "b")],
      invitations: [invite({ id: 9, login: "c" })],
      // CSV-only rows d/e are not rendered (team-driven).
      students: [csvRow({ username: "d" }), csvRow({ username: "e" })],
    })
    expect(countByState(rows)).toEqual({
      enrolled: 2,
      pending: 1,
      needs_attention_in_org: 0,
      needs_attention_not_in_org: 0,
    })
  })

  it("rowToStudent projects all Student fields from a roster row", () => {
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
      // primary role recorded from team membership (student team here)
      role: "student",
    })
  })
})

describe("buildTeamRoster — needs-attention (CSV row on no team)", () => {
  it("suppresses CSV-only rows when org membership is unknown (degrade)", () => {
    const rows = buildTeamRoster({
      members: [member(1, "ada")],
      students: [csvRow({ github_id: "50", username: "wanda" })],
      // orgMembersKnown omitted -> defaults false -> no needs-attention rows.
    })
    expect(rows.map((r) => r.username)).toEqual(["ada"])
  })

  it("renders an active org member on no team as needs_attention_in_org (no role)", () => {
    const rows = buildTeamRoster({
      members: [],
      students: [csvRow({ github_id: "50", username: "wanda" })],
      orgMembersKnown: true,
      orgMemberIds: new Set(["50"]),
      orgMemberLogins: new Set(["wanda"]),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      state: "needs_attention_in_org",
      username: "wanda",
      github_id: "50",
      // placeholder role only; the view renders no role badge.
      roles: ["student"],
    })
  })

  it("renders a non-org-member on no team as needs_attention_not_in_org", () => {
    const rows = buildTeamRoster({
      members: [],
      students: [csvRow({ github_id: "77", username: "stranger" })],
      orgMembersKnown: true,
      orgMemberIds: new Set(),
      orgMemberLogins: new Set(),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      state: "needs_attention_not_in_org",
      username: "stranger",
    })
  })

  it("classifies by login when the CSV row has no github_id", () => {
    const rows = buildTeamRoster({
      members: [],
      students: [csvRow({ username: "Wanda" })],
      orgMembersKnown: true,
      orgMemberIds: new Set(),
      orgMemberLogins: new Set(["wanda"]),
    })
    expect(rows[0].state).toBe("needs_attention_in_org")
  })

  it("a removed TA (CSV role ta, on no team, still an org member) reads as needs_attention_in_org, not student/enrolled", () => {
    const rows = buildTeamRoster({
      members: [],
      staffMembers: { instructor: [], ta: [] },
      students: [
        csvRow({
          github_id: "50",
          username: "tania",
          role: "ta",
        } as Partial<Student>),
      ],
      orgMembersKnown: true,
      orgMemberIds: new Set(["50"]),
      orgMemberLogins: new Set(["tania"]),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe("needs_attention_in_org")
    // The row asserts no team role (placeholder only) — never renders as "ta".
    expect(rows[0].roles).toEqual(["student"])
  })

  it("does not emit a needs-attention row for someone already enrolled or pending", () => {
    const rows = buildTeamRoster({
      members: [member(1, "ada")],
      invitations: [invite({ id: 9, login: "pat" })],
      students: [
        csvRow({ github_id: "1", username: "ada" }),
        csvRow({ username: "pat" }),
        csvRow({ github_id: "50", username: "wanda" }),
      ],
      orgMembersKnown: true,
      orgMemberIds: new Set(["1", "50"]),
      orgMemberLogins: new Set(["ada", "wanda"]),
    })
    // ada=enrolled, pat=pending, wanda=needs_attention_in_org (only one NA row).
    expect(countByState(rows)).toEqual({
      enrolled: 1,
      pending: 1,
      needs_attention_in_org: 1,
      needs_attention_not_in_org: 0,
    })
  })

  it("sorts needs-attention after enrolled and pending", () => {
    const rows = buildTeamRoster({
      members: [member(2, "zed")],
      invitations: [invite({ id: 9, login: "pat" })],
      students: [csvRow({ github_id: "50", username: "wanda" })],
      orgMembersKnown: true,
      orgMemberIds: new Set(["50"]),
      orgMemberLogins: new Set(["wanda"]),
    })
    expect(rows.map((r) => r.state)).toEqual([
      "enrolled",
      "pending",
      "needs_attention_in_org",
    ])
  })

  it("excludes needs-attention rows from enrolled role counts", () => {
    const rows = buildTeamRoster({
      members: [member(1, "ada")],
      students: [csvRow({ github_id: "50", username: "wanda" })],
      orgMembersKnown: true,
      orgMemberIds: new Set(["50"]),
      orgMemberLogins: new Set(["wanda"]),
    })
    expect(enrolledCountsByRole(rows)).toEqual({
      instructor: 0,
      ta: 0,
      student: 1,
    })
  })

  it("suppresses needs-attention rows when pending is hidden (non-owner), avoiding a not_in_org mislabel", () => {
    // A non-owner passes invitations: [] (pending hidden). A CSV row for someone
    // whose only signal was a now-hidden pending invite must NOT be mislabeled
    // needs_attention_not_in_org — the whole pass is suppressed without the
    // pending list, even though org members happen to be readable.
    const rows = buildTeamRoster({
      members: [],
      invitations: [], // hidden for a non-owner
      students: [csvRow({ github_id: "77", username: "invitee" })],
      orgMembersKnown: true,
      orgMemberIds: new Set(),
      orgMemberLogins: new Set(),
      pendingHidden: true,
    })
    expect(rows).toHaveLength(0)
  })
})

describe("buildTeamRoster — roles (union across student + staff teams)", () => {
  it("tags a student-team member as student", () => {
    const rows = buildTeamRoster({
      members: [member(1, "stu")],
      students: [],
    })
    expect(rows[0].roles).toEqual(["student"])
  })

  it("tags a staff-team member with their role", () => {
    const rows = buildTeamRoster({
      members: [],
      staffMembers: { ta: [member(2, "tessa")] },
      students: [],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: "enrolled", username: "tessa" })
    expect(rows[0].roles).toEqual(["ta"])
  })

  it("unions roles for a person on both the student and instructor teams (one row)", () => {
    const rows = buildTeamRoster({
      members: [member(3, "prof")],
      staffMembers: { instructor: [member(3, "prof")] },
      students: [],
    })
    expect(rows).toHaveLength(1)
    // Sorted by ROLE_RANK: instructor before student.
    expect(rows[0].roles).toEqual(["instructor", "student"])
  })

  it("credits a staff member who is also pending elsewhere as enrolled (no dup)", () => {
    const rows = buildTeamRoster({
      members: [member(4, "ada")],
      staffInvitations: { instructor: [invite({ id: 5, login: "ada" })] },
      students: [],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe("enrolled")
    // The stale login-invite for an active member is skipped, so no instructor
    // role is added from it.
    expect(rows[0].roles).toEqual(["student"])
  })

  it("tags a pending staff invite with the team's role", () => {
    const rows = buildTeamRoster({
      members: [],
      staffInvitations: { ta: [invite({ id: 6, login: "newta" })] },
      students: [],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: "pending", username: "newta" })
    expect(rows[0].roles).toEqual(["ta"])
    expect(rows[0].invitation_id).toBe(6)
  })

  it("tags an email-only pending staff invite by email", () => {
    const rows = buildTeamRoster({
      members: [],
      staffInvitations: {
        instructor: [invite({ id: 7, email: "prof@uni.edu" })],
      },
      students: [csvRow({ email: "prof@uni.edu", first_name: "Prof" })],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: "pending", first_name: "Prof" })
    expect(rows[0].roles).toEqual(["instructor"])
  })

  it("tags a TA-team invite as TA only, not student, when GitHub also echoes it into the org-level invitations", () => {
    // Adding a not-yet-org-member to the TA team lists them in BOTH the
    // team-scoped invitations AND the org-level invitations (same invite id).
    // The org-level list can only be blanket-tagged "student", so the row must
    // resolve to ["ta"] — not ["ta","student"] and never just ["student"].
    const rows = buildTeamRoster({
      members: [],
      invitations: [invite({ id: 42, login: "newta" })],
      staffInvitations: { ta: [invite({ id: 42, login: "newta" })] },
      students: [],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: "pending", username: "newta" })
    expect(rows[0].roles).toEqual(["ta"])
  })

  it("tags an email-only staff invite echoed into org-level invitations as staff only", () => {
    const rows = buildTeamRoster({
      members: [],
      invitations: [invite({ id: 43, email: "ta@uni.edu" })],
      staffInvitations: { ta: [invite({ id: 43, email: "ta@uni.edu" })] },
      students: [],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: "pending", email: "ta@uni.edu" })
    expect(rows[0].roles).toEqual(["ta"])
  })

  it("keeps a genuine student-only pending invite as student", () => {
    // No staff-team echo: a plain org invite is a student.
    const rows = buildTeamRoster({
      members: [],
      invitations: [invite({ id: 44, login: "stu" })],
      students: [],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].roles).toEqual(["student"])
  })

  it("unions a person pending on both staff teams (instructor + ta)", () => {
    const rows = buildTeamRoster({
      members: [],
      invitations: [invite({ id: 45, login: "both" })],
      staffInvitations: {
        instructor: [invite({ id: 45, login: "both" })],
        ta: [invite({ id: 45, login: "both" })],
      },
      students: [],
    })
    expect(rows).toHaveLength(1)
    // Sorted by ROLE_RANK; no spurious "student".
    expect(rows[0].roles).toEqual(["instructor", "ta"])
  })

  it("includes every STAFF_ROLES role (guards STAFF_ROLES drift)", () => {
    // One staff member per role; the roster must surface all of them. If a new
    // staff role were added to STAFF_ROLES but the builder's fanout drifted,
    // that role's member would be dropped and this fails.
    const staffMembers = Object.fromEntries(
      STAFF_ROLES.map((role, i) => [role, [member(100 + i, `staff-${role}`)]]),
    )
    const rows = buildTeamRoster({ members: [], staffMembers, students: [] })
    const seen = new Set(rows.flatMap((r) => r.roles))
    for (const role of STAFF_ROLES) expect(seen.has(role)).toBe(true)
    expect(rows).toHaveLength(STAFF_ROLES.length)
  })
})

describe("rowsNeedingBackfill", () => {
  it("flags a login-only row on a team (blank github_id) — the login-only-row case", () => {
    const needing = rowsNeedingBackfill(
      [member(127826836, "student1")],
      {},
      [csvRow({ username: "student1" })], // blank github_id + blank role
    )
    expect(needing.map((s) => s.username)).toEqual(["student1"])
  })

  it("flags a row whose recorded role is stale vs the team", () => {
    const needing = rowsNeedingBackfill(
      [],
      { instructor: [member(1, "prof")] },
      [csvRow({ github_id: "1", username: "prof", role: "student" })],
    )
    expect(needing.map((s) => s.username)).toEqual(["prof"])
  })

  it("does not flag a complete, in-sync row", () => {
    const needing = rowsNeedingBackfill([member(1, "ada")], {}, [
      csvRow({ github_id: "1", username: "ada", role: "student" }),
    ])
    expect(needing).toEqual([])
  })

  it("does not flag a CSV row for someone on no team (needs-attention, not backfill)", () => {
    const needing = rowsNeedingBackfill([], {}, [csvRow({ username: "ghost" })])
    expect(needing).toEqual([])
  })
})

describe("teamMembersMissingFromCsv", () => {
  it("returns team members with no CSV row (matched by id/login/email)", () => {
    const missing = teamMembersMissingFromCsv(
      [member(101, "ada"), member(202, "grace"), member(303, "edsger")],
      [
        csvRow({ github_id: "101" }), // ada matched by id
        csvRow({ username: "GRACE" }), // grace matched by login (case-insensitive)
      ],
    )
    expect(missing.map((m) => m.login)).toEqual(["edsger"])
  })

  it("matches by profile email too (mirrors syncRosterFromTeam)", () => {
    const missing = teamMembersMissingFromCsv(
      [member(101, "ada", { email: "ADA@uni.edu" })],
      [csvRow({ email: "ada@uni.edu" })],
    )
    expect(missing).toEqual([])
  })

  it("is empty when every team member already has a CSV row (in sync)", () => {
    const missing = teamMembersMissingFromCsv(
      [member(101, "ada"), member(202, "grace")],
      [csvRow({ github_id: "101" }), csvRow({ github_id: "202" })],
    )
    expect(missing).toEqual([])
  })

  it("counts every team member missing when the CSV is empty", () => {
    const missing = teamMembersMissingFromCsv(
      [member(101, "ada"), member(202, "grace")],
      [],
    )
    expect(missing.map((m) => m.login)).toEqual(["ada", "grace"])
  })

  it("does not count a CSV row not on the team as missing — wrong direction", () => {
    // grace is on the CSV but not the team — the opposite drift, NOT what this
    // helper (or Sync) addresses.
    const missing = teamMembersMissingFromCsv(
      [member(101, "ada")],
      [csvRow({ github_id: "101" }), csvRow({ username: "grace" })],
    )
    expect(missing).toEqual([])
  })
})

describe("buildTeamRoster — CSV-only rows do not render (team-driven)", () => {
  it("does not render a CSV row for someone on no team or invite", () => {
    // The team is the source of truth for who appears. A roster.csv row with a
    // username/id but no matching team member or pending invite produces NO row
    // (it only enriches team/invite rows).
    const rows = buildTeamRoster({
      members: [member(101, "ada")],
      students: [
        csvRow({ github_id: "101", username: "ada" }),
        csvRow({ github_id: "202", username: "bob", role: "ta" }),
      ],
    })
    expect(rows.map((r) => r.username)).toEqual(["ada"])
  })

  it("renders nothing when the CSV has rows but no team members or invites", () => {
    const rows = buildTeamRoster({
      members: [],
      students: [csvRow({ username: "ghost" }), csvRow({ username: "casper" })],
    })
    expect(rows).toEqual([])
  })
})

describe("githubOrgRoleForRole / roleForGitHubOrgRole — classroom<->org role mapping", () => {
  it("maps instructor to org OWNER (admin), student/ta to direct_member", () => {
    expect(githubOrgRoleForRole("instructor")).toBe("admin")
    expect(githubOrgRoleForRole("ta")).toBe("direct_member")
    expect(githubOrgRoleForRole("student")).toBe("direct_member")
  })

  it("maps admin back to instructor, everything else to student", () => {
    expect(roleForGitHubOrgRole("admin")).toBe("instructor")
    expect(roleForGitHubOrgRole("direct_member")).toBe("student")
    // An unrecognized/absent org role is treated as a plain student, never a
    // silent owner grant.
    expect(roleForGitHubOrgRole("")).toBe("student")
    expect(roleForGitHubOrgRole("member")).toBe("student")
  })

  it("round-trips instructor (the security-sensitive owner grant)", () => {
    expect(roleForGitHubOrgRole(githubOrgRoleForRole("instructor"))).toBe(
      "instructor",
    )
  })
})

describe("isOwnerGitHubOrgRole — wire org-role owner test", () => {
  it("only `admin` is an owner; member/absent/unknown are not", () => {
    expect(isOwnerGitHubOrgRole("admin")).toBe(true)
    expect(isOwnerGitHubOrgRole("member")).toBe(false)
    expect(isOwnerGitHubOrgRole("")).toBe(false)
    expect(isOwnerGitHubOrgRole("direct_member")).toBe(false)
  })
})
