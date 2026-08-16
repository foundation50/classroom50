// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest"

const listInviteTeams = vi.fn()
const readInviteTeam = vi.fn()
const deleteInviteTeam = vi.fn()
const listTeamMembers = vi.fn()
const listOrgInvitations = vi.fn()
const assertClassroomNotArchived = vi.fn()
const withRosterRewrite = vi.fn()

vi.mock("@/github-core/mutations", () => ({
  listInviteTeams: (...a: unknown[]) => listInviteTeams(...a),
  readInviteTeam: (...a: unknown[]) => readInviteTeam(...a),
  deleteInviteTeam: (...a: unknown[]) => deleteInviteTeam(...a),
}))
vi.mock("@/github-core/queries", () => ({
  listTeamMembers: (...a: unknown[]) => listTeamMembers(...a),
  listOrgInvitations: (...a: unknown[]) => listOrgInvitations(...a),
}))
vi.mock("../classrooms", () => ({
  assertClassroomNotArchived: (...a: unknown[]) =>
    assertClassroomNotArchived(...a),
}))
vi.mock("./rosterPrimitives", () => ({
  withRosterRewrite: (...a: unknown[]) => withRosterRewrite(...a),
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

import { backfillInviteMetadata } from "./inviteBackfill"
import { inviteTeamName } from "@/util/inviteTeam"
import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"

const client = {} as never

const emptyRateLimit: GitHubRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const rateLimitError = () =>
  new GitHubAPIError({
    status: 429,
    url: "https://api.github.com/x",
    message: "rate limited",
    body: null,
    rateLimit: emptyRateLimit,
  })

// Build a valid invite-team state for (classroom, email) with the given
// regular-role members (readInviteTeam already excludes maintainers, i.e. the
// auto-added owner), so the description's email hashes back to the slug.
// createdAt defaults to "just now" (never a GC candidate).
async function inviteState(
  classroom: string,
  email: string,
  members: { id: number; login: string }[],
  extra: {
    first_name?: string
    last_name?: string
    section?: string
    createdAt?: string
  } = {},
) {
  const slug = await inviteTeamName(classroom, email)
  const { createdAt, ...fields } = extra
  return {
    slug,
    description: {
      schema: "classroom50/invite/v1",
      email,
      classroom,
      ...fields,
    },
    createdAt: createdAt ?? new Date().toISOString(),
    members,
  }
}

// Older than the 24h GC age guard.
const OLD_ENOUGH = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()

beforeEach(() => {
  vi.clearAllMocks()
  assertClassroomNotArchived.mockResolvedValue(undefined)
  deleteInviteTeam.mockResolvedValue(undefined)
  listOrgInvitations.mockResolvedValue([])
  // Default: every accepted invitee used below is still on a classroom team.
  listTeamMembers.mockResolvedValue([
    { id: 2, login: "member2" },
    { id: 3, login: "member3" },
  ])
  // Default rewrite: run the mutate fn against an empty roster and report change.
  withRosterRewrite.mockImplementation(
    async (_c: unknown, _i: unknown, mutate: (rows: unknown[]) => unknown) =>
      mutate([]),
  )
})

describe("backfillInviteMetadata", () => {
  it("no invite teams -> no-op", async () => {
    listInviteTeams.mockResolvedValue([])
    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    expect(result.backfilled).toEqual([])
    expect(withRosterRewrite).not.toHaveBeenCalled()
    expect(deleteInviteTeam).not.toHaveBeenCalled()
    expect(listTeamMembers).not.toHaveBeenCalled()
  })

  it("backfills the one accepted member and deletes the team", async () => {
    const state = await inviteState("cs101", "alice@example.com", [
      { id: 2, login: "alice" },
    ])
    listInviteTeams.mockResolvedValue([{ slug: state.slug }])
    readInviteTeam.mockResolvedValue(state)

    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })

    expect(result.backfilled).toEqual(["alice@example.com"])
    expect(deleteInviteTeam).toHaveBeenCalledWith(client, "org", state.slug)
    // The rewrite appended an identity row carrying the recovered email.
    const rewriteResult = await withRosterRewrite.mock.results[0].value
    expect(rewriteResult.changed).toBe(1)
    expect(rewriteResult.nextStudents[0]).toMatchObject({
      username: "alice",
      github_id: "2",
      email: "alice@example.com",
    })
  })

  it("keeps a still-pending team (no regular members, younger than the GC age)", async () => {
    const state = await inviteState("cs101", "bob@example.com", [])
    listInviteTeams.mockResolvedValue([{ slug: state.slug }])
    readInviteTeam.mockResolvedValue(state)

    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    expect(result.backfilled).toEqual([])
    expect(deleteInviteTeam).not.toHaveBeenCalled()
    // Too young to be a GC candidate — the invitations list isn't even read.
    expect(listOrgInvitations).not.toHaveBeenCalled()
  })

  it("GCs an aged member-less team whose org invitation is gone (cancelled/expired)", async () => {
    const state = await inviteState("cs101", "gone@example.com", [], {
      createdAt: OLD_ENOUGH,
    })
    listInviteTeams.mockResolvedValue([{ slug: state.slug }])
    readInviteTeam.mockResolvedValue(state)

    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    expect(result.deletedStale).toBe(1)
    expect(deleteInviteTeam).toHaveBeenCalledWith(client, "org", state.slug)
    expect(withRosterRewrite).not.toHaveBeenCalled()
  })

  it("keeps an aged member-less team whose org invitation is still pending", async () => {
    const state = await inviteState("cs101", "waiting@example.com", [], {
      createdAt: OLD_ENOUGH,
    })
    listInviteTeams.mockResolvedValue([{ slug: state.slug }])
    readInviteTeam.mockResolvedValue(state)
    listOrgInvitations.mockResolvedValue([
      { id: 1, login: null, email: "waiting@example.com" },
    ])

    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    expect(result.deletedStale).toBe(0)
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("keeps an aged member-less team when the invitations read fails (fail-safe)", async () => {
    const state = await inviteState("cs101", "held@example.com", [], {
      createdAt: OLD_ENOUGH,
    })
    listInviteTeams.mockResolvedValue([{ slug: state.slug }])
    readInviteTeam.mockResolvedValue(state)
    listOrgInvitations.mockRejectedValue(new Error("boom"))

    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    expect(result.deletedStale).toBe(0)
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("keeps an aged member-less team with no created_at (never reap on uncertainty)", async () => {
    const state = await inviteState("cs101", "unknown@example.com", [])
    state.createdAt = null as unknown as string
    listInviteTeams.mockResolvedValue([{ slug: state.slug }])
    readInviteTeam.mockResolvedValue(state)

    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    expect(result.deletedStale).toBe(0)
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("skips a team with >1 regular member (anomaly)", async () => {
    const state = await inviteState("cs101", "carol@example.com", [
      { id: 2, login: "carol" },
      { id: 3, login: "intruder" },
    ])
    listInviteTeams.mockResolvedValue([{ slug: state.slug }])
    readInviteTeam.mockResolvedValue(state)

    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    expect(result.backfilled).toEqual([])
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("ignores a team whose description email doesn't hash to its name (tampered)", async () => {
    const state = await inviteState("cs101", "dan@example.com", [
      { id: 2, login: "dan" },
    ])
    // Tamper: keep the slug, change the recorded email to a different address.
    state.description.email = "attacker@example.com"
    listInviteTeams.mockResolvedValue([{ slug: state.slug }])
    readInviteTeam.mockResolvedValue(state)

    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    expect(result.backfilled).toEqual([])
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("ignores a team belonging to another classroom", async () => {
    const state = await inviteState("cs102", "eve@example.com", [
      { id: 2, login: "eve" },
    ])
    listInviteTeams.mockResolvedValue([{ slug: state.slug }])
    readInviteTeam.mockResolvedValue(state)

    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    expect(result.backfilled).toEqual([])
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("deletes without a roster write when the invitee is off every classroom team (unenrolled)", async () => {
    const state = await inviteState("cs101", "gone@example.com", [
      { id: 99, login: "gone" },
    ])
    listInviteTeams.mockResolvedValue([{ slug: state.slug }])
    readInviteTeam.mockResolvedValue(state)
    listTeamMembers.mockResolvedValue([]) // on no classroom team

    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    expect(result.backfilled).toEqual([])
    expect(result.deletedStale).toBe(1)
    expect(withRosterRewrite).not.toHaveBeenCalled()
    expect(deleteInviteTeam).toHaveBeenCalledWith(client, "org", state.slug)
  })

  it("skips a team (no delete) when the enrollment read fails", async () => {
    const state = await inviteState("cs101", "held@example.com", [
      { id: 2, login: "held" },
    ])
    listInviteTeams.mockResolvedValue([{ slug: state.slug }])
    readInviteTeam.mockResolvedValue(state)
    listTeamMembers.mockRejectedValue(new Error("boom"))

    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    expect(result.backfilled).toEqual([])
    expect(result.deletedStale).toBe(0)
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("does nothing on an archived classroom", async () => {
    assertClassroomNotArchived.mockRejectedValue(new Error("archived"))
    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    expect(result.backfilled).toEqual([])
    expect(listInviteTeams).not.toHaveBeenCalled()
  })

  it("never throws: a failing team list yields an empty result", async () => {
    listInviteTeams.mockRejectedValue(new Error("boom"))
    await expect(
      backfillInviteMetadata(client, { org: "org", classroom: "cs101" }),
    ).resolves.toEqual({ backfilled: [], deletedStale: 0 })
  })

  it("teacher-entered roster values win over the recovered record", async () => {
    const state = await inviteState(
      "cs101",
      "frank@example.com",
      [{ id: 2, login: "frank" }],
      { first_name: "RecordFirst", section: "RecordSec" },
    )
    listInviteTeams.mockResolvedValue([{ slug: state.slug }])
    readInviteTeam.mockResolvedValue(state)
    // Existing row already has a teacher-set first_name and section.
    withRosterRewrite.mockImplementation(
      async (_c: unknown, _i: unknown, mutate: (rows: unknown[]) => unknown) =>
        mutate([
          {
            username: "frank",
            github_id: "2",
            first_name: "TeacherFirst",
            last_name: "",
            email: "",
            section: "TeacherSec",
            role: "",
          },
        ]),
    )

    await backfillInviteMetadata(client, { org: "org", classroom: "cs101" })
    const rewriteResult = await withRosterRewrite.mock.results[0].value
    const row = rewriteResult.nextStudents[0]
    // Teacher values kept; only the blank email borrowed from the record.
    expect(row.first_name).toBe("TeacherFirst")
    expect(row.section).toBe("TeacherSec")
    expect(row.email).toBe("frank@example.com")
  })

  it("one bad team never blocks the rest", async () => {
    const good = await inviteState("cs101", "grace@example.com", [
      { id: 3, login: "grace" },
    ])
    listInviteTeams.mockResolvedValue([
      { slug: "invite-bad" },
      { slug: good.slug },
    ])
    readInviteTeam.mockImplementation(
      async (_c: unknown, _o: unknown, slug: string) => {
        if (slug === "invite-bad") throw new Error("boom")
        return good
      },
    )

    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    expect(result.backfilled).toEqual(["grace@example.com"])
  })

  it("a rate limit stops the pass instead of hammering the remaining teams", async () => {
    listInviteTeams.mockResolvedValue([
      { slug: "invite-aaaaaaaaaaaaaaaa" },
      { slug: "invite-bbbbbbbbbbbbbbbb" },
    ])
    readInviteTeam.mockRejectedValue(rateLimitError())

    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    expect(result.backfilled).toEqual([])
    expect(readInviteTeam).toHaveBeenCalledTimes(1)
  })

  it("reports a completed backfill even when the team delete fails", async () => {
    const state = await inviteState("cs101", "kept@example.com", [
      { id: 2, login: "kept" },
    ])
    listInviteTeams.mockResolvedValue([{ slug: state.slug }])
    readInviteTeam.mockResolvedValue(state)
    deleteInviteTeam.mockRejectedValue(new Error("boom"))

    const result = await backfillInviteMetadata(client, {
      org: "org",
      classroom: "cs101",
    })
    // The roster write completed, so the caller must still invalidate; the
    // leftover team is retried (idempotently) on the next pass.
    expect(result.backfilled).toEqual(["kept@example.com"])
  })
})
