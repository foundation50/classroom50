// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest"

const createGitCommit = vi.fn()
const createGitTree = vi.fn()
const updateRef = vi.fn()
const getRawFile = vi.fn()
const getBranchRef = vi.fn()
const getCommit = vi.fn()
const getConfigRepoBranch = vi.fn()
const resolveClassroomTeamSlugs = vi.fn()
const listClassroomMembersWithRoles = vi.fn()
const collectInviteRecoveries = vi.fn()
const pendingInviteEmails = vi.fn()

vi.mock("@/github-core/mutations", () => ({
  createGitCommit: (...a: unknown[]) => createGitCommit(...a),
  createGitTree: (...a: unknown[]) => createGitTree(...a),
  updateRef: (...a: unknown[]) => updateRef(...a),
}))
vi.mock("@/github-core/queries", () => ({
  getRawFile: (...a: unknown[]) => getRawFile(...a),
}))
vi.mock("@/github-core/configRepoReads", () => ({
  getBranchRef: (...a: unknown[]) => getBranchRef(...a),
  getCommit: (...a: unknown[]) => getCommit(...a),
  getConfigRepoBranch: (...a: unknown[]) => getConfigRepoBranch(...a),
}))
vi.mock("../classrooms", () => ({
  withGitConflictRetry: (fn: () => unknown) => fn(),
  assertClassroomNotArchived: () => Promise.resolve(),
}))
vi.mock("./rosterPrimitives", () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  // Mirrors the real helper (one blob at the roster path); hand-rolled because
  // importing the actual module would drag in the unmocked github-core surface.
  rosterWriteTree: (classroom: string, csv: string) => [
    {
      path: `${classroom}/roster.csv`,
      mode: "100644",
      type: "blob",
      content: csv,
    },
  ],
  resolveClassroomTeamSlugs: (...a: unknown[]) =>
    resolveClassroomTeamSlugs(...a),
  listClassroomMembersWithRoles: (...a: unknown[]) =>
    listClassroomMembersWithRoles(...a),
}))
vi.mock("./inviteRecoveries", () => ({
  collectInviteRecoveries: (...a: unknown[]) => collectInviteRecoveries(...a),
  pendingInviteEmails: (...a: unknown[]) => pendingInviteEmails(...a),
}))

import { syncRosterFromTeam } from "./rosterSync"
import type { InviteReconcileState } from "./inviteRecoveries"

const client = {} as never
const INPUT = { org: "org", classroom: "cs101" }

const HEADER = "username,first_name,last_name,email,section,github_id,role\n"

const emptyInvites = (
  over: Partial<InviteReconcileState> = {},
): InviteReconcileState => ({
  recovered: [],
  liveInviteEmails: new Set(),
  trusted: true,
  deletedStale: 0,
  ...over,
})

// The CSV the closure committed, parsed back into row objects (or null when no
// commit was made).
const committed = { csv: null as string | null }
const rowsFromCommit = () => {
  if (committed.csv === null) return null
  const [header, ...lines] = committed.csv.trim().split("\n")
  const fields = header.split(",")
  return lines.map((line) =>
    Object.fromEntries(line.split(",").map((v, i) => [fields[i], v])),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  committed.csv = null
  getConfigRepoBranch.mockResolvedValue("main")
  getBranchRef.mockResolvedValue({ object: { sha: "base-sha" } })
  getCommit.mockResolvedValue({ tree: { sha: "base-tree" } })
  resolveClassroomTeamSlugs.mockResolvedValue({
    student: "classroom50-cs101",
    staff: {
      teacher: "classroom50-cs101-teacher",
      hta: "classroom50-cs101-hta",
      ta: "classroom50-cs101-ta",
    },
  })
  listClassroomMembersWithRoles.mockResolvedValue({
    members: [],
    fullyRead: true,
    pendingRoleKeys: new Set(),
  })
  pendingInviteEmails.mockResolvedValue(new Set())
  collectInviteRecoveries.mockResolvedValue(emptyInvites())
  createGitTree.mockImplementation(
    (_c: unknown, input: { tree: { content?: string }[] }) => {
      committed.csv = input.tree[0]?.content ?? null
      return Promise.resolve({ sha: "tree-sha" })
    },
  )
  createGitCommit.mockResolvedValue({ sha: "commit-sha" })
  updateRef.mockResolvedValue(undefined)
})

describe("syncRosterFromTeam — late-acceptance re-collect (#756)", () => {
  it("folds a mid-pass acceptor onto their email row instead of appending a duplicate", async () => {
    // Ada accepted BETWEEN the caller's collect (which saw her invite team
    // member-less: her email is "live", nothing recovered) and this closure's
    // team read (which sees her enrolled).
    getRawFile.mockResolvedValue(HEADER + ",Ada,Lovelace,ada@uni.edu,,,student")
    listClassroomMembersWithRoles.mockResolvedValue({
      members: [{ id: 42, login: "ada", role: "student" }],
      fullyRead: true,
      pendingRoleKeys: new Set(),
    })
    collectInviteRecoveries.mockResolvedValue(
      emptyInvites({
        recovered: [
          {
            email: "ada@uni.edu",
            invitee: { id: 42, login: "ada" },
            slug: "invite-aaaaaaaaaaaaaaaa",
          },
        ],
      }),
    )

    const result = await syncRosterFromTeam(client, {
      ...INPUT,
      invites: emptyInvites({ liveInviteEmails: new Set(["ada@uni.edu"]) }),
    })

    // The stale caller state forced ONE decision-time re-collect — READ-ONLY:
    // deletes stay with the top-level reconcile.
    expect(collectInviteRecoveries).toHaveBeenCalledTimes(1)
    expect(collectInviteRecoveries).toHaveBeenCalledWith(client, {
      ...INPUT,
      readOnly: true,
    })
    // ...whose mapping upgraded the invite-time row in place: identity filled,
    // teacher metadata kept, NO appended duplicate, NO removal.
    expect(rowsFromCommit()).toEqual([
      {
        username: "ada",
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@uni.edu",
        section: "",
        github_id: "42",
        role: "student",
      },
    ])
    expect(result.addedUsernames).toEqual([])
    expect(result.removedEmails).toEqual([])
    expect(result.recoveredEmails).toEqual(["ada@uni.edu"])
    // The landed fold records the mapping, so its team is safe to retire.
    expect(result.recordedRecoveries).toEqual([
      {
        email: "ada@uni.edu",
        invitee: { id: 42, login: "ada" },
        slug: "invite-aaaaaaaaaaaaaaaa",
      },
    ])
  })

  it("still appends a genuinely new member after the re-collect proves no mapping", async () => {
    getRawFile.mockResolvedValue(HEADER)
    listClassroomMembersWithRoles.mockResolvedValue({
      members: [{ id: 7, login: "zed", role: "student" }],
      fullyRead: true,
      pendingRoleKeys: new Set(),
    })

    const result = await syncRosterFromTeam(client, {
      ...INPUT,
      invites: emptyInvites(),
    })

    expect(collectInviteRecoveries).toHaveBeenCalledTimes(1)
    expect(result.addedUsernames).toEqual(["zed"])
    expect(result.recordedRecoveries).toEqual([])
    expect(rowsFromCommit()).toEqual([
      {
        username: "zed",
        first_name: "",
        last_name: "",
        email: "",
        section: "",
        github_id: "7",
        role: "student",
      },
    ])
  })

  // The roster stays interactive during a sync, so a student unenrolled while
  // the pass runs can still be on its (stale or eventually-consistent) team
  // read. The excludeLogins accessor carries that decision into the closure:
  // their append is skipped rather than resurrecting the row just removed.
  it("never appends a just-unenrolled login (excludeLogins), appending the rest", async () => {
    getRawFile.mockResolvedValue(HEADER)
    listClassroomMembersWithRoles.mockResolvedValue({
      members: [
        { id: 7, login: "zed", role: "student" },
        // Mixed case pins the normalization: suppression stores lowercase.
        { id: 8, login: "Gone", role: "student" },
      ],
      fullyRead: true,
      pendingRoleKeys: new Set(),
    })

    const excludeLogins = vi.fn(() => new Set(["gone"]))
    const result = await syncRosterFromTeam(client, {
      ...INPUT,
      invites: emptyInvites(),
      excludeLogins,
    })

    // Read at decision time, inside the retried closure, so a suppression
    // added while the pass was already in flight lands on a retry.
    expect(excludeLogins).toHaveBeenCalled()
    expect(result.addedUsernames).toEqual(["zed"])
    expect(rowsFromCommit()?.map((r) => r.username)).toEqual(["zed"])
  })

  it("does not re-collect when every member is already claimed or recovered", async () => {
    getRawFile.mockResolvedValue(
      HEADER + "ada,Ada,Lovelace,ada@uni.edu,,42,student",
    )
    listClassroomMembersWithRoles.mockResolvedValue({
      members: [{ id: 42, login: "ada", role: "student" }],
      fullyRead: true,
      pendingRoleKeys: new Set(),
    })

    const result = await syncRosterFromTeam(client, {
      ...INPUT,
      invites: emptyInvites(),
    })

    expect(collectInviteRecoveries).not.toHaveBeenCalled()
    expect(result.noop).toBe(true)
  })

  it("keeps removals off in plain mode even when a re-collect ran", async () => {
    // Plain team sync (no invites passed): the caller proved nothing about the
    // invite lifecycle, so even a trusted re-collect must not authorize reaping
    // the email-only row — only the fold and the append may act.
    getRawFile.mockResolvedValue(HEADER + ",Bea,Ng,bea@uni.edu,,,student")
    listClassroomMembersWithRoles.mockResolvedValue({
      members: [{ id: 9, login: "zoe", role: "student" }],
      fullyRead: true,
      pendingRoleKeys: new Set(),
    })

    const result = await syncRosterFromTeam(client, INPUT)

    expect(collectInviteRecoveries).toHaveBeenCalledTimes(1)
    // Plain mode may only ever run a READ-ONLY collect — no team deletions
    // from a mutation hook's sync.
    expect(collectInviteRecoveries).toHaveBeenCalledWith(client, {
      ...INPUT,
      readOnly: true,
    })
    // No liveness confirmation was even attempted: removals never arm.
    expect(pendingInviteEmails).not.toHaveBeenCalled()
    expect(result.removedEmails).toEqual([])
    const rows = rowsFromCommit()
    expect(rows?.map((r) => r.email)).toContain("bea@uni.edu")
    expect(result.addedUsernames).toEqual(["zoe"])
  })

  it("a DEGRADED re-collect merges, never replaces: caller folds land, removals disarm", async () => {
    // The caller collected a trusted recovery for Ada, then the in-closure
    // re-collect (triggered by unknown member Zed) degrades to the never-throw
    // empty state. Replacing the caller's state would skip Ada's fold while
    // her team is finalized — the #756-class loss the merge rule prevents.
    getRawFile.mockResolvedValue(
      HEADER +
        ",Ada,Lovelace,ada@uni.edu,,,student\n" +
        ",Dead,Row,dead@uni.edu,,,student",
    )
    listClassroomMembersWithRoles.mockResolvedValue({
      members: [
        { id: 42, login: "ada", role: "student" },
        { id: 7, login: "zed", role: "student" },
      ],
      fullyRead: true,
      pendingRoleKeys: new Set(),
    })
    collectInviteRecoveries.mockResolvedValue(emptyInvites({ trusted: false }))
    // The caller's (trusted) state says dead@uni.edu has no live backing.
    const ADA = {
      email: "ada@uni.edu",
      invitee: { id: 42, login: "ada" },
      slug: "invite-aaaaaaaaaaaaaaaa",
    }

    const result = await syncRosterFromTeam(client, {
      ...INPUT,
      invites: emptyInvites({ recovered: [ADA] }),
    })

    // Ada's fold still landed from the caller's recovery...
    const rows = rowsFromCommit()
    expect(rows?.find((r) => r.username === "ada")).toMatchObject({
      github_id: "42",
      email: "ada@uni.edu",
      first_name: "Ada",
    })
    // ...her recorded mapping is finalizable...
    expect(result.recordedRecoveries).toEqual([ADA])
    // ...and the untrusted re-collect disarmed removals (dead row survives).
    expect(result.removedEmails).toEqual([])
    expect(rows?.map((r) => r.email)).toContain("dead@uni.edu")
    expect(pendingInviteEmails).not.toHaveBeenCalled()
  })

  it("only RECORDED mappings are finalizable: an unlanded recovery keeps its team", async () => {
    // The caller recovered Eve, but her invitee is invisible to this closure's
    // members read (degraded staff read) and no row names her — nothing lands.
    // Her mapping must NOT be reported recorded, or finalize would delete the
    // only record of her address.
    getRawFile.mockResolvedValue(HEADER + ",Ada,Lovelace,ada@uni.edu,,,student")
    listClassroomMembersWithRoles.mockResolvedValue({
      members: [{ id: 42, login: "ada", role: "student" }],
      fullyRead: false,
      pendingRoleKeys: new Set(),
    })
    const ADA = {
      email: "ada@uni.edu",
      invitee: { id: 42, login: "ada" },
      slug: "invite-aaaaaaaaaaaaaaaa",
    }
    const EVE = {
      email: "eve@uni.edu",
      invitee: { id: 99, login: "eve" },
      slug: "invite-eeeeeeeeeeeeeeee",
    }

    const result = await syncRosterFromTeam(client, {
      ...INPUT,
      invites: emptyInvites({ recovered: [ADA, EVE] }),
    })

    // Ada folded (row records her mapping); Eve landed nowhere.
    expect(result.recordedRecoveries).toEqual([ADA])
    expect(rowsFromCommit()?.some((r) => r.username === "eve")).toBe(false)
  })

  it("a noop pass still reports mappings the file already records", async () => {
    // Ada's row already carries identity + email (a prior pass folded it, but
    // finalize failed). Nothing to commit — yet her team is provably redundant
    // and must be retirable, or it would leak until some other change lands.
    getRawFile.mockResolvedValue(
      HEADER + "ada,Ada,Lovelace,ada@uni.edu,,42,student",
    )
    listClassroomMembersWithRoles.mockResolvedValue({
      members: [{ id: 42, login: "ada", role: "student" }],
      fullyRead: true,
      pendingRoleKeys: new Set(),
    })
    const ADA = {
      email: "ada@uni.edu",
      invitee: { id: 42, login: "ada" },
      slug: "invite-aaaaaaaaaaaaaaaa",
    }

    const result = await syncRosterFromTeam(client, {
      ...INPUT,
      invites: emptyInvites({ recovered: [ADA] }),
    })

    expect(result.noop).toBe(true)
    expect(committed.csv).toBeNull()
    expect(result.recordedRecoveries).toEqual([ADA])
  })
})
