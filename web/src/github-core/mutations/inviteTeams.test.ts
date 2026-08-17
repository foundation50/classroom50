// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import {
  ensureInviteTeam,
  InviteTeamNotSecretError,
  InviteTeamNotEmptyError,
  readInviteTeam,
  listInviteTeams,
  deleteInviteTeam,
  deleteInviteTeamForEmail,
  purgeClassroomInviteTeams,
} from "./inviteTeams"
import type { GitHubClient } from "../client"
import { GitHubAPIError, type GitHubRateLimit } from "../errors"
import {
  inviteTeamName,
  marshalInviteDescription,
  parseInviteDescription,
} from "@/util/inviteTeam"

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
// The teacher performing the invite. GitHub auto-adds them as a maintainer of
// the team they create, so ensureInviteTeam drops them again.
const ACTOR = "ms-frizzle"

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

// The invite team must hold NO teacher: GitHub auto-adds the creator as a
// maintainer, and a teacher sitting on the team is indistinguishable from an
// invitee who accepted (an org-owner invitee is auto-promoted to maintainer
// too). Dropping the actor is what lets the reconcile treat any member of any
// role as the accepted invitee.
describe("ensureInviteTeam", () => {
  const methodsOf = (calls: Call[]) =>
    calls.map((c) => c.options?.method ?? "GET")
  const isMembershipDelete = (c: Call) =>
    c.options?.method === "DELETE" && c.url.includes("/memberships/")

  it("creates a fresh secret team, drops the acting teacher, then writes the email", async () => {
    const name = await inviteTeamName(METADATA.classroom, METADATA.email)
    const { client, calls } = makeClient((url, options) => {
      if (options?.method === "POST" && url === "/orgs/acme/teams") {
        const body = options.body as Record<string, unknown>
        expect(body.privacy).toBe("secret")
        expect(body.name).toBe(name)
        return {
          id: 7,
          slug: name,
          privacy: "secret",
          description: body.description,
        }
      }
      if (options?.method === "DELETE") return undefined
      if (url.includes("/members")) return []
      if (options?.method === "PATCH") {
        return {
          id: 7,
          slug: name,
          privacy: "secret",
          description: DESCRIPTION,
        }
      }
      throw new Error(`unexpected ${url}`)
    })

    const ref = await ensureInviteTeam(client, "acme", METADATA, ACTOR)
    expect(ref).toEqual({ id: 7, slug: name, created: true })
    // Create (no email) -> drop the teacher -> prove empty -> write the email.
    expect(methodsOf(calls)).toEqual(["POST", "DELETE", "GET", "PATCH"])
    expect(calls[1].url).toBe(`/orgs/acme/teams/${name}/memberships/${ACTOR}`)
  })

  it("adopts an existing team on 422, forcing secret before writing the email", async () => {
    const name = await inviteTeamName(METADATA.classroom, METADATA.email)
    const privacyPatches: unknown[] = []
    const { client, calls } = makeClient((url, options) => {
      if (options?.method === "POST") throw apiError(422)
      if (options?.method === "DELETE") return undefined
      if (url.includes("/members")) return []
      if (options?.method === "PATCH") {
        privacyPatches.push(options.body)
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
    const ref = await ensureInviteTeam(client, "acme", METADATA, ACTOR)
    expect(ref).toEqual({ id: 7, slug: name, created: false })
    expect(methodsOf(calls)).toEqual([
      "POST",
      "GET",
      "PATCH",
      "DELETE",
      "GET",
      "PATCH",
    ])
    // Privacy is fixed first, on its own — the email rides only the last PATCH.
    expect(privacyPatches[0]).toEqual({ privacy: "secret" })
    expect(privacyPatches[1]).toEqual({
      privacy: "secret",
      description: DESCRIPTION,
    })
  })

  // Not gated on created-vs-adopted: a team that already exists may still carry
  // a teacher from an earlier run, and leaving them there would make the next
  // reconcile read the teacher as the accepted invitee.
  it("drops the acting teacher from an ADOPTED team too", async () => {
    const name = await inviteTeamName(METADATA.classroom, METADATA.email)
    const { client, calls } = makeClient((url, options) => {
      if (options?.method === "POST") throw apiError(422)
      if (options?.method === "DELETE") return undefined
      if (url.includes("/members")) return []
      return { id: 7, slug: name, privacy: "secret", description: DESCRIPTION }
    })

    const ref = await ensureInviteTeam(client, "acme", METADATA, ACTOR)
    expect(ref.created).toBe(false)
    expect(methodsOf(calls)).toEqual(["POST", "GET", "DELETE", "GET", "PATCH"])
    expect(calls[2].url).toBe(`/orgs/acme/teams/${name}/memberships/${ACTOR}`)
  })

  it("fails closed when the team can't be made secret, before touching membership", async () => {
    const name = await inviteTeamName(METADATA.classroom, METADATA.email)
    const { client, calls } = makeClient((_url, options) => {
      if (options?.method === "POST") throw apiError(422)
      // Both the adopt read and the PATCH report a stubbornly closed team.
      return { id: 7, slug: name, privacy: "closed", description: DESCRIPTION }
    })

    await expect(
      ensureInviteTeam(client, "acme", METADATA, ACTOR),
    ).rejects.toThrow(InviteTeamNotSecretError)
    expect(calls.filter(isMembershipDelete)).toEqual([])
  })

  it("writes the email only AFTER the team is confirmed teacher-free", async () => {
    const name = await inviteTeamName(METADATA.classroom, METADATA.email)
    const bodies: { method: string; description?: string }[] = []
    const { client } = makeClient((url, options) => {
      const method = options?.method ?? "GET"
      const body = options?.body as { description?: string } | undefined
      if (method === "POST" || method === "PATCH") {
        bodies.push({ method, description: body?.description })
      }
      if (method === "POST") {
        return {
          id: 7,
          slug: name,
          privacy: "secret",
          description: body?.description,
        }
      }
      if (method === "DELETE") return undefined
      if (url.includes("/members")) return []
      if (method === "PATCH") {
        return {
          id: 7,
          slug: name,
          privacy: "secret",
          description: DESCRIPTION,
        }
      }
      throw new Error(`unexpected ${url}`)
    })

    await ensureInviteTeam(client, "acme", METADATA, ACTOR)

    // The create must not carry the invited address: if the run dies before the
    // actor is dropped, the leftover team holds a teacher but NO email, so the
    // reconcile can't misread it as an accepted invite.
    expect(bodies[0].method).toBe("POST")
    expect(bodies[0].description).not.toContain(METADATA.email)
    // And whatever it does carry must not parse as an invite record.
    expect(parseInviteDescription(bodies[0].description ?? null)).toBeNull()
    // The real record lands last, after the membership DELETE.
    expect(bodies.at(-1)).toMatchObject({
      method: "PATCH",
      description: DESCRIPTION,
    })
  })

  // An adopted team may still carry a DIFFERENT teacher stranded by an earlier
  // run, and dropping `actor` alone wouldn't clear them. Nobody has accepted yet
  // (the invitation isn't sent until this returns), so any member is a stray.
  it("fails closed when an ADOPTED team still has a member, writing no email", async () => {
    const name = await inviteTeamName(METADATA.classroom, METADATA.email)
    const patched: unknown[] = []
    const { client } = makeClient((_url, options) => {
      if (options?.method === "POST") throw apiError(422)
      if (options?.method === "PATCH") {
        patched.push(options.body)
        return { id: 7, slug: name, privacy: "secret", description: "x" }
      }
      if (options?.method === "DELETE") return undefined
      if (_url.includes("/members")) return [{ id: 99, login: "other-teacher" }]
      return { id: 7, slug: name, privacy: "secret", description: "x" }
    })

    await expect(
      ensureInviteTeam(client, "acme", METADATA, ACTOR),
    ).rejects.toThrow(InviteTeamNotEmptyError)
    expect(
      patched.filter((b) => JSON.stringify(b).includes(METADATA.email)),
    ).toEqual([])
  })

  it("rethrows a non-422 create failure", async () => {
    const { client } = makeClient(() => {
      throw apiError(500)
    })
    await expect(
      ensureInviteTeam(client, "acme", METADATA, ACTOR),
    ).rejects.toMatchObject({ status: 500 })
  })

  // A run that dies between the create and the membership drop is unavoidable
  // (GitHub adds the creator during the create itself), so the leftover team is
  // made harmless rather than cleaned up: it holds a teacher but no email, and
  // no parseable record, so the reconcile skips it entirely.
  it("leaves no email behind when the acting teacher can't be dropped", async () => {
    const name = await inviteTeamName(METADATA.classroom, METADATA.email)
    const descriptions: (string | undefined)[] = []
    const { client } = makeClient((url, options) => {
      const body = options?.body as { description?: string } | undefined
      if (options?.method === "POST") {
        descriptions.push(body?.description)
        return {
          id: 7,
          slug: name,
          privacy: "secret",
          description: body?.description,
        }
      }
      if (options?.method === "PATCH") descriptions.push(body?.description)
      if (options?.method === "DELETE" && url.includes("/memberships/")) {
        throw apiError(500)
      }
      throw new Error(`unexpected ${url}`)
    })

    await expect(
      ensureInviteTeam(client, "acme", METADATA, ACTOR),
    ).rejects.toMatchObject({ status: 500 })
    for (const d of descriptions) expect(d ?? "").not.toContain(METADATA.email)
  })

  // The membership read-back is the proof, so a degraded read must not pass as
  // "empty" and let the email be written onto a team holding a teacher.
  it("fails closed when the membership read-back fails", async () => {
    const name = await inviteTeamName(METADATA.classroom, METADATA.email)
    const { client, calls } = makeClient((url, options) => {
      if (options?.method === "POST") {
        return { id: 7, slug: name, privacy: "secret", description: "x" }
      }
      if (options?.method === "DELETE") return undefined
      if (url.includes("/members")) throw apiError(500)
      throw new Error(`unexpected ${url}`)
    })

    await expect(
      ensureInviteTeam(client, "acme", METADATA, ACTOR),
    ).rejects.toMatchObject({ status: 500 })
    expect(calls.filter((c) => c.options?.method === "PATCH")).toEqual([])
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

  it("parses the description and lists members of EVERY role", async () => {
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
    // Unfiltered on purpose: the team holds no teacher, so every member is the
    // invitee — including an org owner, whom GitHub auto-promotes to maintainer
    // and a role=member filter would hide.
    const memberCall = calls.find((c) => c.url.includes("/members"))
    expect(memberCall?.url).not.toContain("role=")
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
