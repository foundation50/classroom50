import { describe, expect, it } from "vitest"
import {
  classifyRosterUpload,
  membershipLookup,
  hasTeacherPromotion,
  type CurrentMembership,
  type PreflightRow,
  type ResolvedMembership,
} from "./rosterUploadPreflight"

// A lookup built from an explicit per-username map, for the pure classifier.
const lookupFrom =
  (map: Record<string, CurrentMembership>) =>
  (row: PreflightRow): CurrentMembership | undefined =>
    map[row.username.toLowerCase()]

describe("classifyRosterUpload", () => {
  it("invites a non-member", () => {
    const rows: PreflightRow[] = [{ username: "ada", role: "student" }]
    const result = classifyRosterUpload(
      rows,
      lookupFrom({ ada: { isOrgMember: false, roles: [] } }),
    )
    expect(result.needsInvite.map((o) => o.username)).toEqual(["ada"])
    expect(result.allAlreadyMembers).toBe(false)
  })

  it("treats an unknown (unmatched) row as needing an invite", () => {
    const rows: PreflightRow[] = [{ username: "ghost", role: "student" }]
    const result = classifyRosterUpload(rows, lookupFrom({}))
    expect(result.needsInvite.map((o) => o.username)).toEqual(["ghost"])
  })

  it("is a no-op when the member already holds the CSV role", () => {
    const rows: PreflightRow[] = [{ username: "ada", role: "student" }]
    const result = classifyRosterUpload(
      rows,
      lookupFrom({ ada: { isOrgMember: true, roles: ["student"] } }),
    )
    expect(result.noAction.map((o) => o.username)).toEqual(["ada"])
    expect(result.roleChanges).toHaveLength(0)
  })

  it("no-ops a multi-role member whose set includes the CSV role", () => {
    // On both instructor + student teams, CSV says student -> already on it.
    const rows: PreflightRow[] = [{ username: "prof", role: "student" }]
    const result = classifyRosterUpload(
      rows,
      lookupFrom({
        prof: { isOrgMember: true, roles: ["instructor", "student"] },
      }),
    )
    expect(result.noAction.map((o) => o.username)).toEqual(["prof"])
  })

  it("enrolls an active member on no classroom team (additive, no confirm)", () => {
    const rows: PreflightRow[] = [{ username: "newmember", role: "student" }]
    const result = classifyRosterUpload(
      rows,
      lookupFrom({ newmember: { isOrgMember: true, roles: [] } }),
    )
    expect(result.enroll.map((o) => o.username)).toEqual(["newmember"])
    expect(result.roleChanges).toHaveLength(0)
  })

  it("flags a role change when a student is uploaded as TA", () => {
    // User B on the student team; CSV assigns ta.
    const rows: PreflightRow[] = [{ username: "userb", role: "ta" }]
    const result = classifyRosterUpload(
      rows,
      lookupFrom({ userb: { isOrgMember: true, roles: ["student"] } }),
    )
    expect(result.roleChanges).toEqual([
      {
        kind: "role_change",
        username: "userb",
        role: "ta",
        currentRole: "student",
        currentRoles: ["student"],
      },
    ])
  })

  it("flags a role change when a TA is uploaded as student (downgrade)", () => {
    // User A listed as student but currently on the TA team.
    const rows: PreflightRow[] = [{ username: "usera", role: "student" }]
    const result = classifyRosterUpload(
      rows,
      lookupFrom({ usera: { isOrgMember: true, roles: ["ta"] } }),
    )
    expect(result.roleChanges).toEqual([
      {
        kind: "role_change",
        username: "usera",
        role: "student",
        currentRole: "ta",
        currentRoles: ["ta"],
      },
    ])
  })

  it("uses the highest-precedence current role for a multi-team member", () => {
    // On instructor + ta; CSV says student -> change from instructor (highest).
    const rows: PreflightRow[] = [{ username: "boss", role: "student" }]
    const result = classifyRosterUpload(
      rows,
      lookupFrom({ boss: { isOrgMember: true, roles: ["ta", "instructor"] } }),
    )
    expect(result.roleChanges[0]).toMatchObject({
      username: "boss",
      role: "student",
      currentRole: "instructor",
    })
    // Carries the FULL current role set so the move drops both staff teams.
    expect(result.roleChanges[0].currentRoles).toEqual(["ta", "instructor"])
  })

  it("reports allAlreadyMembers when nobody needs an invite", () => {
    const rows: PreflightRow[] = [
      { username: "ada", role: "student" },
      { username: "userb", role: "ta" },
    ]
    const result = classifyRosterUpload(
      rows,
      lookupFrom({
        ada: { isOrgMember: true, roles: ["student"] },
        userb: { isOrgMember: true, roles: ["student"] },
      }),
    )
    expect(result.allAlreadyMembers).toBe(true)
    expect(result.needsInvite).toHaveLength(0)
  })

  it("skips blank usernames", () => {
    const rows: PreflightRow[] = [{ username: "   ", role: "student" }]
    const result = classifyRosterUpload(rows, lookupFrom({}))
    expect(result.outcomes).toHaveLength(0)
  })
})

describe("membershipLookup", () => {
  const resolved: ResolvedMembership = {
    orgMemberIds: new Set(["101"]),
    orgMemberLogins: new Set(["ada"]),
    teamIdsByRole: {
      student: new Set(["101"]),
      teacher: new Set<string>(),
      instructor: new Set<string>(),
      hta: new Set<string>(),
      ta: new Set<string>(),
    },
    teamLoginsByRole: {
      student: new Set(["ada"]),
      teacher: new Set<string>(),
      instructor: new Set<string>(),
      hta: new Set<string>(),
      ta: new Set(["helper"]),
    },
  }

  it("matches by github_id first", () => {
    const lookup = membershipLookup(resolved)
    const m = lookup({
      username: "renamed-ada",
      github_id: "101",
      role: "student",
    })
    expect(m.isOrgMember).toBe(true)
    expect(m.roles).toContain("student")
  })

  it("matches by login when id is absent", () => {
    const lookup = membershipLookup(resolved)
    expect(lookup({ username: "helper", role: "ta" }).roles).toEqual(["ta"])
    // helper is on the ta team but not in the org-member sets in this fixture.
    expect(lookup({ username: "helper", role: "ta" }).isOrgMember).toBe(false)
  })

  it("returns no roles and non-member for an unknown account", () => {
    const lookup = membershipLookup(resolved)
    const m = lookup({ username: "nobody", role: "student" })
    expect(m).toEqual({ isOrgMember: false, roles: [] })
  })
})

describe("hasTeacherPromotion", () => {
  it("is true only when a change targets teacher", () => {
    expect(
      hasTeacherPromotion([
        {
          kind: "role_change",
          username: "a",
          role: "ta",
          currentRole: "student",
          currentRoles: ["student"],
        },
      ]),
    ).toBe(false)
    expect(
      hasTeacherPromotion([
        {
          kind: "role_change",
          username: "b",
          role: "teacher",
          currentRole: "student",
          currentRoles: ["student"],
        },
      ]),
    ).toBe(true)
  })
})
