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

    // The stale caller state forced ONE decision-time re-collect...
    expect(collectInviteRecoveries).toHaveBeenCalledTimes(1)
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
    // The late mapping is surfaced so reconcileRoster can retire its team.
    expect(result.lateRecovered).toEqual([
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
    expect(result.lateRecovered).toEqual([])
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
    // No liveness confirmation was even attempted: removals never arm.
    expect(pendingInviteEmails).not.toHaveBeenCalled()
    expect(result.removedEmails).toEqual([])
    const rows = rowsFromCommit()
    expect(rows?.map((r) => r.email)).toContain("bea@uni.edu")
    expect(result.addedUsernames).toEqual(["zoe"])
  })
})
