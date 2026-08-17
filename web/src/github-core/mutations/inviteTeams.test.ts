// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import {
  ensureInviteTeam,
  InviteTeamNotSecretError,
  readInviteTeam,
  listInviteTeams,
  deleteInviteTeam,
  deleteInviteTeamForEmail,
  purgeClassroomInviteTeams,
} from "./inviteTeams"
import type { GitHubClient } from "../client"
import { GitHubAPIError, type GitHubRateLimit } from "../errors"
import { inviteTeamName, marshalInviteDescription } from "@/util/inviteTeam"

const emptyRateLimit: GitHubRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const apiError = (status: number, message = `boom ${status}`) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/x",
    message,
    body: null,
    rateLimit: emptyRateLimit,
  })

const rateLimitError = () =>
  new GitHubAPIError({
    status: 429,
    url: "https://api.github.com/x",
    message: "rate limited",
    body: null,
    rateLimit: emptyRateLimit,
  })

const METADATA = { email: "alice@example.com", classroom: "cs101" }
const DESCRIPTION = marshalInviteDescription(METADATA)

type Call = { url: string; options?: { method?: string; body?: unknown } }

// A request mock that dispatches on method+url, recording every call.
function makeClient(
  handler: (url: string, options?: Call["options"]) => unknown,
) {
  const calls: Call[] = []
  const request = vi.fn(async (url: string, options?: Call["options"]) => {
    calls.push({ url, options })
    return handler(url, options)
  })
  return { client: { request } as unknown as GitHubClient, request, calls }
}

describe("ensureInviteTeam", () => {
  it("creates a fresh secret team and reports created: true (no PATCH)", async () => {
    const name = await inviteTeamName(METADATA.classroom, METADATA.email)
    const { client, calls } = makeClient((url, options) => {
      if (options?.method === "POST" && url === "/orgs/acme/teams") {
        const body = options.body as Record<string, unknown>
        expect(body.privacy).toBe("secret")
        expect(body.description).toBe(DESCRIPTION)
        expect(body.name).toBe(name)
        return {
          id: 7,
          slug: name,
          privacy: "secret",
          description: DESCRIPTION,
        }
      }
      throw new Error(`unexpected ${url}`)
    })

    const ref = await ensureInviteTeam(client, "acme", METADATA)
    expect(ref).toEqual({ id: 7, slug: name, created: true })
    expect(calls).toHaveLength(1)
  })

  it("adopts an existing team on 422, forcing secret + description via PATCH (created: false)", async () => {
    const name = await inviteTeamName(METADATA.classroom, METADATA.email)
    const { client, calls } = makeClient((_url, options) => {
      if (options?.method === "POST") throw apiError(422)
      if (options?.method === "PATCH") {
        expect(options.body).toEqual({
          privacy: "secret",
          description: DESCRIPTION,
        })
        return {
          id: 7,
          slug: name,
          privacy: "secret",
          description: DESCRIPTION,
        }
      }
      // The adopt read: a pre-existing CLOSED team with a stale description.
      return { id: 7, slug: name, privacy: "closed", description: "old" }
    })
    const ref = await ensureInviteTeam(client, "acme", METADATA)
    expect(ref).toEqual({ id: 7, slug: name, created: false })
    expect(calls.map((c) => c.options?.method ?? "GET")).toEqual([
      "POST",
      "GET",
      "PATCH",
    ])
  })

  it("skips the PATCH when the adopted team is already secret with the same description", async () => {
    const name = await inviteTeamName(METADATA.classroom, METADATA.email)
    const { client, calls } = makeClient((_url, options) => {
      if (options?.method === "POST") throw apiError(422)
      return { id: 7, slug: name, privacy: "secret", description: DESCRIPTION }
    })

    const ref = await ensureInviteTeam(client, "acme", METADATA)
    expect(ref.created).toBe(false)
    expect(calls.map((c) => c.options?.method ?? "GET")).toEqual([
      "POST",
      "GET",
    ])
  })

  it("fails closed when the team can't be made secret", async () => {
    const name = await inviteTeamName(METADATA.classroom, METADATA.email)
    const { client } = makeClient((_url, options) => {
      if (options?.method === "POST") throw apiError(422)
      // Both the adopt read and the PATCH report a stubbornly closed team.
      return { id: 7, slug: name, privacy: "closed", description: DESCRIPTION }
    })

    await expect(ensureInviteTeam(client, "acme", METADATA)).rejects.toThrow(
      InviteTeamNotSecretError,
    )
  })

  it("rethrows a non-422 create failure", async () => {
    const { client } = makeClient(() => {
      throw apiError(500)
    })
    await expect(
      ensureInviteTeam(client, "acme", METADATA),
    ).rejects.toMatchObject({ status: 500 })
  })
})

describe("readInviteTeam", () => {
  it("returns null when the team is already gone (404)", async () => {
    const { client } = makeClient(() => {
      throw apiError(404)
    })
    await expect(readInviteTeam(client, "acme", "invite-abc")).resolves.toBe(
      null,
    )
  })

  it("parses the description and lists regular-role members only", async () => {
    const { client, calls } = makeClient((url) => {
      if (url.includes("/members")) return [{ id: 2, login: "alice" }]
      return {
        slug: "invite-abc",
        description: DESCRIPTION,
        created_at: "2026-08-01T00:00:00Z",
      }
    })

    const state = await readInviteTeam(client, "acme", "invite-abc")
    expect(state?.description).toMatchObject({
      email: "alice@example.com",
      classroom: "cs101",
    })
    expect(state?.createdAt).toBe("2026-08-01T00:00:00Z")
    expect(state?.members).toEqual([{ id: 2, login: "alice" }])
    // The maintainer-excluding filter is what keeps the auto-added owner (and
    // any org owner) out of the invitee set.
    const memberCall = calls.find((c) => c.url.includes("/members"))
    expect(memberCall?.url).toContain("role=member")
  })

  it("yields a null description for a non-v1 record (hand-edited team)", async () => {
    const { client } = makeClient((url) => {
      if (url.includes("/members")) return []
      return { slug: "invite-abc", description: "just some text" }
    })
    const state = await readInviteTeam(client, "acme", "invite-abc")
    expect(state).not.toBeNull()
    expect(state?.description).toBeNull()
  })
})

describe("listInviteTeams", () => {
  it("returns only invite- teams", async () => {
    const { client } = makeClient(() => [
      { id: 1, slug: "invite-aaaa" },
      { id: 2, slug: "classroom50-cs101" },
    ])
    const teams = await listInviteTeams(client, "acme")
    expect(teams.map((t) => t.slug)).toEqual(["invite-aaaa"])
  })

  it("throws when the org team list is unreadable (strict: rows depend on it)", async () => {
    const { client } = makeClient(() => {
      throw apiError(404)
    })
    await expect(listInviteTeams(client, "acme")).rejects.toMatchObject({
      status: 404,
    })
  })
})

describe("deleteInviteTeam", () => {
  it("refuses to delete a slug outside the invite- namespace", async () => {
    const { client, request } = makeClient(() => undefined)
    await deleteInviteTeam(client, "acme", "classroom50-cs101")
    expect(request).not.toHaveBeenCalled()
  })

  it("deletes an invite team and tolerates 404 (already gone)", async () => {
    const { client, calls } = makeClient(() => {
      throw apiError(404)
    })
    await expect(
      deleteInviteTeam(client, "acme", "invite-abc"),
    ).resolves.toBeUndefined()
    expect(calls[0]).toMatchObject({
      url: "/orgs/acme/teams/invite-abc",
      options: { method: "DELETE" },
    })
  })
})

describe("deleteInviteTeamForEmail", () => {
  it("hashes (classroom, email) to the slug and deletes that team", async () => {
    const slug = await inviteTeamName("cs101", "alice@example.com")
    const { client, calls } = makeClient(() => undefined)
    await deleteInviteTeamForEmail(client, "acme", {
      classroom: "cs101",
      email: "alice@example.com",
    })
    expect(calls[0]).toMatchObject({
      url: `/orgs/acme/teams/${slug}`,
      options: { method: "DELETE" },
    })
  })

  it("never throws (best-effort cancel-side teardown)", async () => {
    const { client } = makeClient(() => {
      throw apiError(500)
    })
    await expect(
      deleteInviteTeamForEmail(client, "acme", {
        classroom: "cs101",
        email: "alice@example.com",
      }),
    ).resolves.toBeUndefined()
  })
})

// Deleting a classroom is the last moment these teams are findable: they're
// recorded nowhere in the config repo, so once its directory is gone nothing can
// enumerate them per-classroom again. Each holds an invited student's email.
describe("purgeClassroomInviteTeams", () => {
  const teamFor = async (classroom: string, email: string) => ({
    slug: await inviteTeamName(classroom, email),
    description: marshalInviteDescription({ classroom, email }),
  })

  it("deletes only the teams whose record claims this classroom", async () => {
    const mine = await teamFor("cs101", "mine@x.edu")
    const other = await teamFor("cs202", "other@x.edu")
    const deleted: string[] = []
    const { client } = makeClient((url, options) => {
      if (url.includes("/teams?")) {
        return [
          { id: 1, slug: mine.slug },
          { id: 2, slug: other.slug },
        ]
      }
      if (options?.method === "DELETE") {
        deleted.push(url.split("/teams/")[1])
        return undefined
      }
      if (url.includes("/members")) return []
      const slug = url.split("/teams/")[1]
      return slug === mine.slug
        ? { slug: mine.slug, description: mine.description }
        : { slug: other.slug, description: other.description }
    })

    const result = await purgeClassroomInviteTeams(client, "acme", "cs101")
    expect(result).toEqual({
      purged: 1,
      failedSlugs: [],
      unreadable: 0,
      listFailed: false,
    })
    expect(deleted).toEqual([mine.slug])
  })

  it("deletes a team whose record was tampered into claiming this classroom", async () => {
    // The purge only ever deletes, so it takes the claim at face value (the
    // reconcile, which writes a roster row, does verify the hash).
    const foreign = await inviteTeamName("cs999", "someone@x.edu")
    const deleted: string[] = []
    const { client } = makeClient((url, options) => {
      if (url.includes("/teams?")) return [{ id: 1, slug: foreign }]
      if (options?.method === "DELETE") {
        deleted.push(url.split("/teams/")[1])
        return undefined
      }
      if (url.includes("/members")) return []
      return {
        slug: foreign,
        description: marshalInviteDescription({
          classroom: "cs101",
          email: "someone@x.edu",
        }),
      }
    })

    const result = await purgeClassroomInviteTeams(client, "acme", "cs101")
    expect(result.purged).toBe(1)
    expect(deleted).toEqual([foreign])
  })

  it("reports a per-team delete failure instead of throwing", async () => {
    const mine = await teamFor("cs101", "mine@x.edu")
    const { client } = makeClient((url, options) => {
      if (url.includes("/teams?")) return [{ id: 1, slug: mine.slug }]
      if (options?.method === "DELETE") throw apiError(500)
      if (url.includes("/members")) return []
      return { slug: mine.slug, description: mine.description }
    })

    const result = await purgeClassroomInviteTeams(client, "acme", "cs101")
    expect(result.purged).toBe(0)
    expect(result.failedSlugs).toEqual([mine.slug])
    expect(result.listFailed).toBe(false)
  })

  // A team we couldn't READ has an unknown classroom, so naming it to the
  // teacher could send them to delete a live classroom's invite record.
  it("counts an unreadable team without naming it as this classroom's", async () => {
    const { client } = makeClient((url) => {
      if (url.includes("/teams?"))
        return [{ id: 1, slug: "invite-aaaaaaaaaaaaaaaa" }]
      throw apiError(403)
    })

    const result = await purgeClassroomInviteTeams(client, "acme", "cs101")
    expect(result.unreadable).toBe(1)
    expect(result.failedSlugs).toEqual([])
    expect(result.purged).toBe(0)
  })

  it("stops the pass on a rate limit rather than hammering", async () => {
    const reads: string[] = []
    const { client } = makeClient((url) => {
      if (url.includes("/teams?")) {
        return [
          { id: 1, slug: "invite-aaaaaaaaaaaaaaaa" },
          { id: 2, slug: "invite-bbbbbbbbbbbbbbbb" },
          { id: 3, slug: "invite-cccccccccccccccc" },
        ]
      }
      reads.push(url)
      throw rateLimitError()
    })

    const result = await purgeClassroomInviteTeams(client, "acme", "cs101")
    expect(reads).toHaveLength(1)
    expect(result.unreadable).toBe(1)
  })

  it("flags a failed listing so the caller can still warn (nothing was checked)", async () => {
    const { client } = makeClient(() => {
      throw apiError(500)
    })
    const result = await purgeClassroomInviteTeams(client, "acme", "cs101")
    expect(result).toEqual({
      purged: 0,
      failedSlugs: [],
      unreadable: 0,
      listFailed: true,
    })
  })
})
