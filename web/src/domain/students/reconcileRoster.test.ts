// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest"

const collectInviteRecoveries = vi.fn()
const finalizeInviteRecoveries = vi.fn()
const syncRosterFromTeam = vi.fn()
const listInviteTeams = vi.fn()
const readInviteTeam = vi.fn()
const deleteInviteTeam = vi.fn()

vi.mock("./inviteRecoveries", () => ({
  collectInviteRecoveries: (...a: unknown[]) => collectInviteRecoveries(...a),
  finalizeInviteRecoveries: (...a: unknown[]) => finalizeInviteRecoveries(...a),
}))
vi.mock("./rosterSync", () => ({
  syncRosterFromTeam: (...a: unknown[]) => syncRosterFromTeam(...a),
}))
vi.mock("@/github-core/mutations", () => ({
  listInviteTeams: (...a: unknown[]) => listInviteTeams(...a),
  readInviteTeam: (...a: unknown[]) => readInviteTeam(...a),
  deleteInviteTeam: (...a: unknown[]) => deleteInviteTeam(...a),
}))

import { reconcileRoster, purgeInviteTeams } from "./reconcileRoster"

const client = {} as never
const INPUT = { org: "org", classroom: "cs101" }

const RECOVERED = {
  email: "alice@example.com",
  invitee: { id: 2, login: "alice" },
  slug: "invite-aaaaaaaaaaaaaaaa",
}

beforeEach(() => {
  vi.clearAllMocks()
  collectInviteRecoveries.mockResolvedValue({
    recovered: [RECOVERED],
    liveInviteEmails: new Set(),
    trusted: true,
    deletedStale: 1,
  })
  syncRosterFromTeam.mockResolvedValue({
    addedUsernames: [],
    recoveredEmails: ["alice@example.com"],
    removedEmails: [],
    noop: false,
  })
  finalizeInviteRecoveries.mockResolvedValue(undefined)
  deleteInviteTeam.mockResolvedValue(undefined)
})

describe("reconcileRoster", () => {
  it("collects, syncs with the collected state, then finalizes deletes — in order", async () => {
    const order: string[] = []
    collectInviteRecoveries.mockImplementation(async () => {
      order.push("collect")
      return {
        recovered: [RECOVERED],
        liveInviteEmails: new Set(["b@x"]),
        trusted: true,
        deletedStale: 1,
      }
    })
    syncRosterFromTeam.mockImplementation(async () => {
      order.push("sync")
      return {
        addedUsernames: ["alice"],
        recoveredEmails: ["alice@example.com"],
        removedEmails: ["dead@x"],
        noop: false,
      }
    })
    finalizeInviteRecoveries.mockImplementation(async () => {
      order.push("finalize")
    })

    const result = await reconcileRoster(client, INPUT)
    expect(order).toEqual(["collect", "sync", "finalize"])
    // The collected state rides into the sync call...
    expect(syncRosterFromTeam).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        org: "org",
        classroom: "cs101",
        invites: expect.objectContaining({ trusted: true }),
      }),
    )
    // ...and the recovered teams are deleted only after it.
    expect(finalizeInviteRecoveries).toHaveBeenCalledWith(
      client,
      { org: "org", classroom: "cs101" },
      [RECOVERED],
    )
    expect(result).toEqual({
      addedUsernames: ["alice"],
      recoveredEmails: ["alice@example.com"],
      removedEmails: ["dead@x"],
      noop: false,
      deletedStaleTeams: 1,
    })
  })

  it("does NOT delete recovered teams when the sync throws (re-recovered next pass)", async () => {
    syncRosterFromTeam.mockRejectedValue(new Error("archived"))
    await expect(reconcileRoster(client, INPUT)).rejects.toThrow("archived")
    expect(finalizeInviteRecoveries).not.toHaveBeenCalled()
  })
})

describe("purgeInviteTeams", () => {
  it("recovers via the reconcile, then purges the rest of this classroom's teams", async () => {
    listInviteTeams.mockResolvedValue([
      { slug: "invite-tampered" },
      { slug: "invite-other" },
    ])
    readInviteTeam.mockImplementation(
      async (_c: unknown, _o: unknown, slug: string) => {
        if (slug === "invite-tampered") {
          return {
            slug,
            description: { schema: "x", email: "t@x", classroom: "cs101" },
            createdAt: null,
            members: [],
          }
        }
        return {
          slug,
          description: { schema: "x", email: "e@x", classroom: "cs202" },
          createdAt: null,
          members: [],
        }
      },
    )

    const result = await purgeInviteTeams(client, INPUT)
    expect(result.recovered).toEqual(["alice@example.com"])
    // Only the team claiming THIS classroom is purged.
    expect(result.purged).toBe(1)
    expect(deleteInviteTeam).toHaveBeenCalledWith(
      client,
      "org",
      "invite-tampered",
    )
  })

  it("still purges when the reconcile throws (archived classroom)", async () => {
    syncRosterFromTeam.mockRejectedValue(new Error("archived"))
    listInviteTeams.mockResolvedValue([{ slug: "invite-left" }])
    readInviteTeam.mockResolvedValue({
      slug: "invite-left",
      description: { schema: "x", email: "l@x", classroom: "cs101" },
      createdAt: null,
      members: [],
    })

    const result = await purgeInviteTeams(client, INPUT)
    expect(result.recovered).toEqual([])
    expect(result.purged).toBe(1)
  })

  it("throws on a purge-phase failure (an explicit action surfaces errors)", async () => {
    listInviteTeams.mockRejectedValue(new Error("boom"))
    await expect(purgeInviteTeams(client, INPUT)).rejects.toThrow("boom")
  })
})
