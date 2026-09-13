import { describe, expect, it, vi } from "vitest"

import {
  ensureClassroomRoleTeam,
  ensureClassroomTeam,
  ensureStaffTeams,
  UnclaimedTeamError,
} from "./mutations"
import { GitHubAPIError } from "./errors"
import type { GitHubClient, GitHubRequestOptions } from "./client"

// Pins the adopt guard (see AdoptGuard in mutations/teams.ts): the sibling
// classroom check, the config-repo grant, and the recorded-id exception.

type Call = { path: string; options?: GitHubRequestOptions }

function apiError(status: number): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: "x",
    message: "err",
    body: null,
    rateLimit: {
      limit: null,
      remaining: null,
      used: null,
      reset: null,
      resource: null,
      retryAfter: null,
    },
  })
}

// An org where every create POST 422s and the team at each slug is `existing`;
// `granted` slugs hold a config-repo grant, `classrooms` are config-repo dirs.
function makeOrg(opts: {
  existing: Record<string, { id: number; privacy: string }>
  granted: string[]
  classrooms?: string[]
}) {
  const calls: Call[] = []
  const revoked: string[] = []
  const requestRaw = vi.fn(async (path: string): Promise<string> => {
    const m = path.match(/\/contents\/([^/]+)\/classroom\.json$/)
    if (m && (opts.classrooms ?? []).includes(m[1]))
      return JSON.stringify({ short_name: m[1] })
    throw apiError(404)
  })
  const request = vi.fn(
    async (path: string, options?: GitHubRequestOptions): Promise<unknown> => {
      calls.push({ path, options })
      const method = options?.method ?? "GET"
      if (path === "/orgs/acme/teams" && method === "POST") throw apiError(422)
      const probe = path.match(
        /^\/orgs\/acme\/teams\/([^/]+)\/repos\/acme\/classroom50$/,
      )
      if (probe && method === "GET") {
        if (opts.granted.includes(probe[1])) return undefined
        throw apiError(404)
      }
      if (probe && method === "DELETE") {
        if (!opts.granted.includes(probe[1])) throw apiError(404)
        revoked.push(probe[1])
        return undefined
      }
      const teamGet = path.match(/^\/orgs\/acme\/teams\/([^/]+)$/)
      if (teamGet && method === "GET") {
        const team = opts.existing[teamGet[1]]
        if (!team) throw apiError(404)
        return { ...team, slug: teamGet[1] }
      }
      if (teamGet && method === "PATCH") return undefined
      // Ruleset traffic from the exempt pass: not installed.
      if (path.startsWith("/orgs/acme/rulesets")) return []
      throw new Error(`unexpected ${method} ${path}`)
    },
  )
  const client = { request, requestRaw } as unknown as GitHubClient
  const patches = () => calls.filter((c) => c.options?.method === "PATCH")
  return { client, calls, patches, revoked }
}

describe("adopting a team at a staff slug", () => {
  it("adopts and reshapes a team that holds the config-repo grant", async () => {
    const { client, patches } = makeOrg({
      existing: { "classroom50-cs101-ta": { id: 7, privacy: "secret" } },
      granted: ["classroom50-cs101-ta"],
    })
    const team = await ensureClassroomRoleTeam(client, "acme", "cs101", "ta")
    expect(team).toEqual({
      id: 7,
      slug: "classroom50-cs101-ta",
      created: false,
    })
    expect(patches().map((c) => c.options?.body)).toEqual([
      { privacy: "closed" },
    ])
  })

  it("refuses, without a PATCH, a team with no grant and no matching record", async () => {
    // A member squatted the slug (or it is `cs101-ta`'s student team).
    const { client, patches } = makeOrg({
      existing: { "classroom50-cs101-ta": { id: 7, privacy: "secret" } },
      granted: [],
    })
    const err = await ensureClassroomRoleTeam(
      client,
      "acme",
      "cs101",
      "ta",
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UnclaimedTeamError)
    expect((err as UnclaimedTeamError).localized).toEqual({
      key: "staffTeams.unclaimed.staff",
      params: {
        slug: "classroom50-cs101-ta",
        url: "https://github.com/orgs/acme/teams/classroom50-cs101-ta",
      },
    })
    expect((err as UnclaimedTeamError).studentOf).toBeNull()
    expect(patches()).toEqual([])

    // A recorded id that names some other team does not help.
    await expect(
      ensureClassroomRoleTeam(client, "acme", "cs101", "ta", {
        ta: { id: 8, slug: "classroom50-cs101-ta" },
      }),
    ).rejects.toBeInstanceOf(UnclaimedTeamError)
  })

  it("adopts a recorded team whose grant was lost so the caller can re-grant it", async () => {
    const { client, patches } = makeOrg({
      existing: { "classroom50-cs101-ta": { id: 7, privacy: "secret" } },
      granted: [],
    })
    const team = await ensureClassroomRoleTeam(client, "acme", "cs101", "ta", {
      ta: { id: 7, slug: "classroom50-cs101-ta" },
    })
    expect(team.id).toBe(7)
    expect(patches()).toHaveLength(1)
  })

  it("refuses a sibling classroom's student team whatever it holds or records", async () => {
    // `cs101-ta` exists, so `cs101`'s TA slug is its student team; a stale
    // grant and a recorded id do not make it staff.
    const { client, patches } = makeOrg({
      existing: { "classroom50-cs101-ta": { id: 7, privacy: "closed" } },
      granted: ["classroom50-cs101-ta"],
      classrooms: ["cs101", "cs101-ta"],
    })
    const err = await ensureClassroomRoleTeam(client, "acme", "cs101", "ta", {
      ta: { id: 7, slug: "classroom50-cs101-ta" },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UnclaimedTeamError)
    expect((err as UnclaimedTeamError).studentOf).toBe("cs101-ta")
    expect((err as UnclaimedTeamError).localized.key).toBe(
      "staffTeams.unclaimed.studentOf",
    )
    expect(patches()).toEqual([])
  })

  it("ensureStaffTeams leaves an unclaimed role out and reports it", async () => {
    const { client, patches } = makeOrg({
      existing: {
        "classroom50-cs101-teacher": { id: 1, privacy: "closed" },
        "classroom50-cs101-hta": { id: 2, privacy: "closed" },
        "classroom50-cs101-ta": { id: 3, privacy: "secret" },
      },
      granted: ["classroom50-cs101-teacher", "classroom50-cs101-hta"],
    })
    const result = await ensureStaffTeams(client, "acme", "cs101")
    expect(result.teams).toEqual({
      teacher: { id: 1, slug: "classroom50-cs101-teacher" },
      hta: { id: 2, slug: "classroom50-cs101-hta" },
    })
    expect(result.unclaimed.map((e) => e.slug)).toEqual([
      "classroom50-cs101-ta",
    ])
    expect(patches()).toEqual([])
  })
})

describe("adopting a team at the student slug", () => {
  it("adopts the team and strips a stale config-repo grant", async () => {
    // An older release adopted `cs101-ta`'s student team as `cs101`'s TA team
    // and granted it. It is still the roster: adopt, back to secret, grant
    // removed.
    const { client, patches, revoked } = makeOrg({
      existing: { "classroom50-cs101-ta": { id: 7, privacy: "closed" } },
      granted: ["classroom50-cs101-ta"],
      classrooms: ["cs101-ta"],
    })
    const team = await ensureClassroomTeam(client, "acme", "cs101-ta")
    expect(team).toEqual({
      id: 7,
      slug: "classroom50-cs101-ta",
      created: false,
    })
    expect(revoked).toEqual(["classroom50-cs101-ta"])
    expect(patches().map((c) => c.options?.body)).toEqual([
      { privacy: "secret" },
    ])
  })

  it("adopts an ungranted team as the student team", async () => {
    const { client, revoked } = makeOrg({
      existing: { "classroom50-cs101": { id: 7, privacy: "secret" } },
      granted: [],
    })
    const team = await ensureClassroomTeam(client, "acme", "cs101")
    expect(team).toEqual({ id: 7, slug: "classroom50-cs101", created: false })
    expect(revoked).toEqual([])
  })
})
