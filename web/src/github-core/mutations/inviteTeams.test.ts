// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import {
  ensureInviteTeam,
  InviteTeamNotSecretError,
  readInviteTeam,
  listInviteTeams,
  deleteInviteTeam,
  deleteInviteTeamForEmail,
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
