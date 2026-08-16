// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest"

const listInviteTeams = vi.fn()
const readInviteTeam = vi.fn()
const deleteInviteTeam = vi.fn()
const listTeamMembers = vi.fn()
const listOrgInvitations = vi.fn()

vi.mock("@/github-core/mutations", () => ({
  listInviteTeams: (...a: unknown[]) => listInviteTeams(...a),
  readInviteTeam: (...a: unknown[]) => readInviteTeam(...a),
  deleteInviteTeam: (...a: unknown[]) => deleteInviteTeam(...a),
}))
vi.mock("@/github-core/queries", () => ({
  listTeamMembers: (...a: unknown[]) => listTeamMembers(...a),
  listOrgInvitations: (...a: unknown[]) => listOrgInvitations(...a),
}))
vi.mock("./rosterPrimitives", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

import {
  collectInviteRecoveries,
  finalizeInviteRecoveries,
} from "./inviteBackfill"
import { inviteTeamName } from "@/util/inviteTeam"
import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"

const client = {} as never
const INPUT = { org: "org", classroom: "cs101" }

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
  extra: { createdAt?: string } = {},
) {
  const slug = await inviteTeamName(classroom, email)
  return {
    slug,
    description: {
      schema: "classroom50/invite/v1",
      email,
      classroom,
    },
    createdAt: extra.createdAt ?? new Date().toISOString(),
    members,
  }
}

// Older than the 24h GC age guard.
const OLD_ENOUGH = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()

beforeEach(() => {
  vi.clearAllMocks()
  deleteInviteTeam.mockResolvedValue(undefined)
  listOrgInvitations.mockResolvedValue([])
  // Default: every accepted invitee used below is still on a classroom team.
  listTeamMembers.mockResolvedValue([
    { id: 2, login: "member2" },
    { id: 3, login: "member3" },
  ])
})

describe("collectInviteRecoveries", () => {
  it("no invite teams -> empty, trusted state", async () => {
    listInviteTeams.mockResolvedValue([])
    const state = await collectInviteRecoveries(client, INPUT)
    expect(state.recovered).toEqual([])
    expect(state.trusted).toBe(true)
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("classifies an accepted, enrolled member as recovered WITHOUT deleting the team", async () => {
    const team = await inviteState("cs101", "alice@example.com", [
      { id: 2, login: "alice" },
    ])
    listInviteTeams.mockResolvedValue([{ slug: team.slug }])
    readInviteTeam.mockResolvedValue(team)

    const state = await collectInviteRecoveries(client, INPUT)
    expect(state.recovered).toEqual([
      {
        email: "alice@example.com",
        invitee: { id: 2, login: "alice" },
        slug: team.slug,
      },
    ])
    expect(state.trusted).toBe(true)
    // Push-before-delete: the caller deletes AFTER the roster commit lands.
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("counts a young pending team's email as live without reading invitations", async () => {
    const team = await inviteState("cs101", "bob@example.com", [])
    listInviteTeams.mockResolvedValue([{ slug: team.slug }])
    readInviteTeam.mockResolvedValue(team)

    const state = await collectInviteRecoveries(client, INPUT)
    expect(state.liveInviteEmails.has("bob@example.com")).toBe(true)
    expect(state.trusted).toBe(true)
    expect(listOrgInvitations).not.toHaveBeenCalled()
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("GCs an aged member-less team whose org invitation is gone (not live)", async () => {
    const team = await inviteState("cs101", "gone@example.com", [], {
      createdAt: OLD_ENOUGH,
    })
    listInviteTeams.mockResolvedValue([{ slug: team.slug }])
    readInviteTeam.mockResolvedValue(team)

    const state = await collectInviteRecoveries(client, INPUT)
    expect(state.deletedStale).toBe(1)
    expect(state.liveInviteEmails.has("gone@example.com")).toBe(false)
    expect(deleteInviteTeam).toHaveBeenCalledWith(client, "org", team.slug)
  })

  it("keeps an aged member-less team whose org invitation is still pending (live)", async () => {
    const team = await inviteState("cs101", "waiting@example.com", [], {
      createdAt: OLD_ENOUGH,
    })
    listInviteTeams.mockResolvedValue([{ slug: team.slug }])
    readInviteTeam.mockResolvedValue(team)
    listOrgInvitations.mockResolvedValue([
      { id: 1, login: null, email: "waiting@example.com" },
    ])

    const state = await collectInviteRecoveries(client, INPUT)
    expect(state.deletedStale).toBe(0)
    expect(state.liveInviteEmails.has("waiting@example.com")).toBe(true)
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("flips trusted off when the invitations read fails (fail-safe)", async () => {
    const team = await inviteState("cs101", "held@example.com", [], {
      createdAt: OLD_ENOUGH,
    })
    listInviteTeams.mockResolvedValue([{ slug: team.slug }])
    readInviteTeam.mockResolvedValue(team)
    listOrgInvitations.mockRejectedValue(new Error("boom"))

    const state = await collectInviteRecoveries(client, INPUT)
    expect(state.trusted).toBe(false)
    expect(state.deletedStale).toBe(0)
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("keeps an aged member-less team with no created_at as live (never reap on uncertainty)", async () => {
    const team = await inviteState("cs101", "unknown@example.com", [])
    team.createdAt = null as unknown as string
    listInviteTeams.mockResolvedValue([{ slug: team.slug }])
    readInviteTeam.mockResolvedValue(team)

    const state = await collectInviteRecoveries(client, INPUT)
    expect(state.deletedStale).toBe(0)
    expect(state.liveInviteEmails.has("unknown@example.com")).toBe(true)
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("treats a >1-member anomaly as live and never guesses", async () => {
    const team = await inviteState("cs101", "carol@example.com", [
      { id: 2, login: "carol" },
      { id: 3, login: "intruder" },
    ])
    listInviteTeams.mockResolvedValue([{ slug: team.slug }])
    readInviteTeam.mockResolvedValue(team)

    const state = await collectInviteRecoveries(client, INPUT)
    expect(state.recovered).toEqual([])
    expect(state.liveInviteEmails.has("carol@example.com")).toBe(true)
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("treats a tampered description (hash mismatch) as live, never recovered", async () => {
    const team = await inviteState("cs101", "dan@example.com", [
      { id: 2, login: "dan" },
    ])
    // Tamper: keep the slug, change the recorded email to a different address.
    team.description.email = "attacker@example.com"
    listInviteTeams.mockResolvedValue([{ slug: team.slug }])
    readInviteTeam.mockResolvedValue(team)

    const state = await collectInviteRecoveries(client, INPUT)
    expect(state.recovered).toEqual([])
    expect(state.liveInviteEmails.has("attacker@example.com")).toBe(true)
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("ignores a team belonging to another classroom", async () => {
    const team = await inviteState("cs102", "eve@example.com", [
      { id: 2, login: "eve" },
    ])
    listInviteTeams.mockResolvedValue([{ slug: team.slug }])
    readInviteTeam.mockResolvedValue(team)

    const state = await collectInviteRecoveries(client, INPUT)
    expect(state.recovered).toEqual([])
    expect(state.liveInviteEmails.size).toBe(0)
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("deletes the team of an accepted invitee who is off every classroom team (unenrolled)", async () => {
    const team = await inviteState("cs101", "left@example.com", [
      { id: 99, login: "left" },
    ])
    listInviteTeams.mockResolvedValue([{ slug: team.slug }])
    readInviteTeam.mockResolvedValue(team)
    listTeamMembers.mockResolvedValue([]) // on no classroom team

    const state = await collectInviteRecoveries(client, INPUT)
    expect(state.recovered).toEqual([])
    expect(state.deletedStale).toBe(1)
    expect(deleteInviteTeam).toHaveBeenCalledWith(client, "org", team.slug)
  })

  it("flips trusted off when the enrollment read fails, keeping the team", async () => {
    const team = await inviteState("cs101", "held2@example.com", [
      { id: 2, login: "held2" },
    ])
    listInviteTeams.mockResolvedValue([{ slug: team.slug }])
    readInviteTeam.mockResolvedValue(team)
    listTeamMembers.mockRejectedValue(new Error("boom"))

    const state = await collectInviteRecoveries(client, INPUT)
    expect(state.trusted).toBe(false)
    expect(state.recovered).toEqual([])
    expect(deleteInviteTeam).not.toHaveBeenCalled()
  })

  it("never throws: a failing team listing yields an untrusted empty state", async () => {
    listInviteTeams.mockRejectedValue(new Error("boom"))
    const state = await collectInviteRecoveries(client, INPUT)
    expect(state.trusted).toBe(false)
    expect(state.recovered).toEqual([])
    expect(state.deletedStale).toBe(0)
  })

  it("one bad team never blocks the rest, but flips trusted off", async () => {
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

    const state = await collectInviteRecoveries(client, INPUT)
    expect(state.recovered.map((r) => r.email)).toEqual(["grace@example.com"])
    expect(state.trusted).toBe(false)
  })

  it("a rate limit stops the pass and flips trusted off", async () => {
    listInviteTeams.mockResolvedValue([
      { slug: "invite-aaaaaaaaaaaaaaaa" },
      { slug: "invite-bbbbbbbbbbbbbbbb" },
    ])
    readInviteTeam.mockRejectedValue(rateLimitError())

    const state = await collectInviteRecoveries(client, INPUT)
    expect(state.trusted).toBe(false)
    expect(readInviteTeam).toHaveBeenCalledTimes(1)
  })
})

describe("finalizeInviteRecoveries", () => {
  it("deletes every recovered mapping's team, tolerating per-team failures", async () => {
    deleteInviteTeam
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined)
    await expect(
      finalizeInviteRecoveries(client, "org", [
        { email: "a@x", invitee: { id: 1, login: "a" }, slug: "invite-aa" },
        { email: "b@x", invitee: { id: 2, login: "b" }, slug: "invite-bb" },
      ]),
    ).resolves.toBeUndefined()
    expect(deleteInviteTeam).toHaveBeenCalledTimes(2)
    expect(deleteInviteTeam).toHaveBeenLastCalledWith(
      client,
      "org",
      "invite-bb",
    )
  })
})
