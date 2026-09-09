import { describe, expect, it } from "vitest"
import {
  aggregateOrgMembers,
  filterOrgMemberRows,
  orphanedFailedInvitations,
  sortOrgMemberRowsBy,
  type ClassroomRoster,
  type OrgMemberRow,
} from "./orgMembers"
import type { Student } from "@/types/classroom"
import type { GitHubOrgInvitation, GitHubUser } from "@/github-core/types"

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
  role: "",
  ...over,
})

const roster = (
  classroom: string,
  students: Student[],
  archived = false,
): ClassroomRoster => ({ classroom, archived, students })

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

  it("dedupes an email-only student by email across rosters", () => {
    const rows = aggregateOrgMembers(
      [],
      [
        roster("cs101", [student({ email: "x@x.edu" })]),
        roster("cs201", [student({ email: "x@x.edu", section: "P3" })]),
      ],
    )
    expect(rows).toHaveLength(1)
    // With no live invitation on the address, an identity-less row is unlinked
    // (not a departed member: there is no account to have left).
    expect(rows[0].classification).toBe("unlinked")
    expect(rows[0].isMember).toBe(false)
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

  it("aggregates and dedupes every distinct email across rosters", () => {
    // Same person (github_id 42) with a different address per roster, one of
    // them a case-variant duplicate. `email` stays first-seen (identity
    // fallback); `emails` collects the distinct set in first-seen order.
    const rows = aggregateOrgMembers(
      [member(42, "alice")],
      [
        roster("cs101", [
          student({ username: "alice", github_id: "42", email: "a@x.edu" }),
        ]),
        roster("cs201", [
          student({ username: "alice", github_id: "42", email: "A@X.edu" }),
        ]),
        roster("cs301", [
          student({
            username: "alice",
            github_id: "42",
            email: "alice@uni.edu",
          }),
        ]),
      ],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].email).toBe("a@x.edu")
    expect(rows[0].emails).toEqual(["a@x.edu", "alice@uni.edu"])
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

  it("classifies an email row as pending only when GitHub lists a live invitation", () => {
    const rosters = [
      roster("cs101", [student({ email: "ada@uni.edu", first_name: "Ada" })]),
    ]
    // Live invitation on the address: pending, carrying its id.
    const pending = aggregateOrgMembers([], rosters, undefined, {
      pending: [invite({ id: 77, email: "ADA@uni.edu" })],
    })
    expect(pending[0]).toMatchObject({
      classification: "invitation-pending",
      invitation_id: 77,
      isMember: false,
    })
    // Same row, no live invitation: unlinked, not "pending" on faith.
    const unlinked = aggregateOrgMembers([], rosters, undefined, {
      pending: [],
    })
    expect(unlinked[0].classification).toBe("unlinked")
    expect(unlinked[0].invitation_id).toBeUndefined()
  })

  it("treats an unknown pending list as no live invitation (unlinked), never as pending", () => {
    const rows = aggregateOrgMembers(
      [],
      [roster("cs101", [student({ email: "ada@uni.edu" })])],
    )
    expect(rows[0].classification).toBe("unlinked")
  })

  it("marks a login row with a live invitation as pending, not as not-in-org", () => {
    const rows = aggregateOrgMembers(
      [],
      [roster("cs101", [student({ username: "Mona", github_id: "90914" })])],
      undefined,
      { pending: [invite({ id: 5, login: "monalisa" })] },
    )
    // Different casing/login than the roster's stale username: no match, so
    // this row is genuinely not in the org...
    expect(rows[0].classification).toBe("on-roster-not-member")
    // ...while a login match is pending.
    const matched = aggregateOrgMembers(
      [],
      [roster("cs101", [student({ username: "monalisa" })])],
      undefined,
      { pending: [invite({ id: 5, login: "MonaLisa" })] },
    )
    expect(matched[0]).toMatchObject({
      classification: "invitation-pending",
      invitation_id: 5,
    })
  })

  it("attaches the latest failed record to a stranded row, and drops it for members", () => {
    const EXPIRED =
      "Invitation expired. User did not accept this invite for 7 days"
    const rows = aggregateOrgMembers(
      [member(42, "alice")],
      [
        roster("cs101", [
          student({ email: "grace@uni.edu" }),
          student({ username: "monalisa" }),
          student({ username: "alice", github_id: "42" }),
        ]),
      ],
      undefined,
      {
        pending: [],
        failed: [
          invite({
            id: 1,
            email: "grace@uni.edu",
            failed_at: "2026-08-01T00:00:00Z",
            failed_reason: EXPIRED,
          }),
          invite({
            id: 2,
            email: "grace@uni.edu",
            failed_at: "2026-09-07T00:00:00Z",
            failed_reason: EXPIRED,
          }),
          invite({ id: 3, login: "monalisa", failed_reason: "Email bounced" }),
          invite({ id: 4, login: "alice", failed_reason: EXPIRED }),
        ],
      },
    )
    const grace = rows.find((r) => r.email === "grace@uni.edu")!
    expect(grace.classification).toBe("unlinked")
    expect(grace.failed_invitation).toMatchObject({ id: 2, kind: "expired" })
    const mona = rows.find((r) => r.username === "monalisa")!
    expect(mona.classification).toBe("on-roster-not-member")
    expect(mona.failed_invitation).toMatchObject({ id: 3, kind: "failed" })
    const alice = rows.find((r) => r.username === "alice")!
    expect(alice.classification).toBe("member-on-roster")
    expect(alice.failed_invitation).toBeUndefined()
  })

  it("a live invitation wins over an older failed record", () => {
    const rows = aggregateOrgMembers(
      [],
      [roster("cs101", [student({ email: "twice@uni.edu" })])],
      undefined,
      {
        pending: [invite({ id: 9, email: "twice@uni.edu" })],
        failed: [invite({ id: 1, email: "twice@uni.edu" })],
      },
    )
    expect(rows[0]).toMatchObject({
      classification: "invitation-pending",
      invitation_id: 9,
    })
    expect(rows[0].failed_invitation).toBeUndefined()
  })

  it("orders actionable rows first, then members, then pending, then no-roster members", () => {
    const rows = aggregateOrgMembers(
      [member(42, "alice"), member(43, "loner")],
      [
        roster("cs101", [
          student({ email: "pending@uni.edu" }),
          student({ email: "expired@uni.edu" }),
          student({ username: "alice", github_id: "42" }),
          student({ username: "left" }),
        ]),
      ],
      undefined,
      { pending: [invite({ id: 1, email: "pending@uni.edu" })] },
    )
    expect(rows.map((r) => r.classification)).toEqual([
      "on-roster-not-member",
      "unlinked",
      "member-on-roster",
      "invitation-pending",
      "member-no-roster",
    ])
  })
})

describe("sortOrgMemberRowsBy", () => {
  const orgRow = (over: Partial<OrgMemberRow>): OrgMemberRow => ({
    key: over.username ?? "k",
    username: "",
    github_id: "",
    name: "",
    email: "",
    emails: [],
    isMember: true,
    classrooms: [],
    classification: "member-on-roster",
    unprovisionedClassrooms: [],
    ...over,
  })
  const access = (classroom: string) => ({
    classroom,
    archived: false,
    section: "",
    state: "enrolled" as const,
  })

  it("sorts by display identity, falling back name -> email", () => {
    const rows = [
      orgRow({ username: "zed" }),
      orgRow({ key: "e", email: "ada@uni.edu" }),
      orgRow({ username: "bob" }),
    ]
    expect(
      sortOrgMemberRowsBy(rows, "name", "asc").map(
        (r) => r.username || r.email,
      ),
    ).toEqual(["ada@uni.edu", "bob", "zed"])
    expect(
      sortOrgMemberRowsBy(rows, "name", "desc").map(
        (r) => r.username || r.email,
      ),
    ).toEqual(["zed", "bob", "ada@uni.edu"])
  })

  it("sorts by username with blanks last in either direction", () => {
    const rows = [
      orgRow({ username: "zed" }),
      orgRow({ key: "e", email: "ada@uni.edu", name: "Ada" }),
      orgRow({ username: "bob" }),
    ]
    expect(
      sortOrgMemberRowsBy(rows, "username", "asc").map(
        (r) => r.username || r.email,
      ),
    ).toEqual(["bob", "zed", "ada@uni.edu"])
    expect(
      sortOrgMemberRowsBy(rows, "username", "desc").map(
        (r) => r.username || r.email,
      ),
    ).toEqual(["zed", "bob", "ada@uni.edu"])
  })

  it("sorts by org role (owner -> member -> not a member) with a name tiebreak", () => {
    const rows = [
      orgRow({ username: "left", isMember: false }),
      orgRow({ username: "plain" }),
      orgRow({ username: "boss" }),
    ]
    const isOwner = (row: OrgMemberRow) => row.username === "boss"
    expect(
      sortOrgMemberRowsBy(rows, "role", "asc", isOwner).map((r) => r.username),
    ).toEqual(["boss", "plain", "left"])
    expect(
      sortOrgMemberRowsBy(rows, "role", "desc", isOwner).map((r) => r.username),
    ).toEqual(["left", "plain", "boss"])
  })

  it("sorts by classroom count with a name tiebreak", () => {
    const rows = [
      orgRow({ username: "two", classrooms: [access("a"), access("b")] }),
      orgRow({ username: "none" }),
      orgRow({ username: "one", classrooms: [access("a")] }),
      orgRow({ username: "also-one", classrooms: [access("b")] }),
    ]
    expect(
      sortOrgMemberRowsBy(rows, "classrooms", "asc").map((r) => r.username),
    ).toEqual(["none", "also-one", "one", "two"])
    expect(
      sortOrgMemberRowsBy(rows, "classrooms", "desc").map((r) => r.username),
    ).toEqual(["two", "also-one", "one", "none"])
  })

  it("sorts by status precedence (actionable first) with a name tiebreak", () => {
    const rows = [
      orgRow({ username: "staff", classification: "member-no-roster" }),
      orgRow({ username: "left", classification: "on-roster-not-member" }),
      orgRow({ username: "ok", classification: "member-on-roster" }),
      orgRow({ username: "invited", classification: "invitation-pending" }),
    ]
    expect(
      sortOrgMemberRowsBy(rows, "status", "asc").map((r) => r.username),
    ).toEqual(["left", "ok", "invited", "staff"])
  })

  it("keeps the tiebreak ascending on a reversed column and doesn't mutate", () => {
    const rows = [
      orgRow({ username: "b", classrooms: [access("a")] }),
      orgRow({ username: "a", classrooms: [access("a")] }),
    ]
    const sorted = sortOrgMemberRowsBy(rows, "classrooms", "desc")
    expect(sorted.map((r) => r.username)).toEqual(["a", "b"])
    expect(rows.map((r) => r.username)).toEqual(["b", "a"])
  })

  describe("filterOrgMemberRows", () => {
    const rows = [
      orgRow({ username: "boss" }),
      orgRow({ username: "plain" }),
      orgRow({
        username: "left",
        isMember: false,
        classification: "on-roster-not-member",
      }),
      orgRow({
        key: "invited",
        email: "ada@uni.edu",
        isMember: false,
        classification: "invitation-pending",
        invitation_id: 1,
      }),
      orgRow({
        key: "expired",
        email: "grace@uni.edu",
        isMember: false,
        classification: "unlinked",
        failed_invitation: {
          id: 2,
          kind: "expired",
          failed_at: null,
          reason: null,
        },
      }),
      orgRow({ username: "drifted", unprovisionedClassrooms: ["cs101"] }),
    ]
    const isOwner = (row: OrgMemberRow) => row.username === "boss"
    const names = (filtered: OrgMemberRow[]) =>
      filtered.map((r) => r.username || r.email)
    const filter = (
      statusFilter: Parameters<typeof filterOrgMemberRows>[1]["statusFilter"],
      roleFilter: Parameters<typeof filterOrgMemberRows>[1]["roleFilter"],
    ) => names(filterOrgMemberRows(rows, { statusFilter, roleFilter, isOwner }))

    it("passes everything through on the default facets", () => {
      expect(filter("all", "all")).toHaveLength(rows.length)
    })

    it("filters each status facet to its rows", () => {
      expect(filter("not-in-org", "all")).toEqual(["left"])
      expect(filter("invitation-pending", "all")).toEqual(["ada@uni.edu"])
      expect(filter("unlinked", "all")).toEqual(["grace@uni.edu"])
      expect(filter("invite-expired", "all")).toEqual(["grace@uni.edu"])
      expect(filter("not-enrolled", "all")).toEqual(["drifted"])
    })

    it("filters by org role, with non-members matching neither role", () => {
      expect(filter("all", "owner")).toEqual(["boss"])
      expect(filter("all", "member")).toEqual(["plain", "drifted"])
    })
  })
})

describe("orphanedFailedInvitations", () => {
  const EXPIRED =
    "Invitation expired. User did not accept this invite for 7 days"
  const failed = (over: Partial<GitHubOrgInvitation>): GitHubOrgInvitation =>
    ({
      id: 1,
      login: null,
      email: null,
      role: "direct_member",
      created_at: "",
      failed_at: "2026-09-07T00:41:28Z",
      failed_reason: EXPIRED,
      ...over,
    }) as GitHubOrgInvitation

  it("keeps only records no roster row and no member explains", () => {
    const rosters = [
      roster("cs101", [
        student({ email: "on-roster@x.edu" }),
        student({ username: "OnRoster", github_id: "" }),
      ]),
    ]
    const members = [{ ...member(7, "activemember"), email: "m@x.edu" }]
    const out = orphanedFailedInvitations(
      [
        failed({ id: 1, email: "on-roster@x.edu" }),
        failed({ id: 2, login: "onroster" }),
        failed({ id: 3, login: "activemember" }),
        failed({ id: 4, email: "M@x.edu" }),
        failed({ id: 5, email: "gone@x.edu" }),
        failed({ id: 6, login: "left-long-ago" }),
      ],
      members,
      rosters,
    )
    expect(out.map((o) => o.invitation.id).sort()).toEqual([5, 6])
  })

  it("carries the classified failure and sorts newest failure first", () => {
    const out = orphanedFailedInvitations(
      [
        failed({ id: 1, email: "a@x.edu", failed_at: "2026-08-01T00:00:00Z" }),
        failed({
          id: 2,
          email: "b@x.edu",
          failed_at: "2026-09-07T00:00:00Z",
          failed_reason: "Email bounced",
        }),
      ],
      [],
      [],
    )
    expect(out.map((o) => o.invitation.id)).toEqual([2, 1])
    expect(out[0].ref).toMatchObject({
      kind: "failed",
      reason: "Email bounced",
    })
    expect(out[1].ref.kind).toBe("expired")
  })

  it("is empty when there is nothing failed", () => {
    expect(orphanedFailedInvitations([], [member(1, "a")], [])).toEqual([])
  })
})
