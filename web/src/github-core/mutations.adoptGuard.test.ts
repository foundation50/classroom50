import { describe, expect, it, vi } from "vitest"

import {
  ensureClassroomRoleTeam,
  ensureClassroomTeam,
  ensureStaffTeams,
  UnclaimedTeamError,
} from "./mutations"
import { GitHubAPIError } from "./errors"
import type { GitHubClient, GitHubRequestOptions } from "./client"

// A team at a canonical slug proves nothing by itself: any org member can
// create one (members_can_create_teams is on for student groups), and a
// classroom `cs101-ta` puts its student team at `cs101`'s TA slug. Only an
// owner-run Classroom 50 flow grants a team access to the `classroom50` config
// repo, so that grant is what the adopt path checks before it reshapes,
// exempts, or records anything. These tests pin that gate and its one
// exception (a recorded team whose grant step failed).

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

// An org where every create POST 422s (the team already exists) and the team
// at each slug is `existing`. `granted` lists the slugs that hold a grant on the
// config repo.
function makeOrg(opts: {
  existing: Record<string, { id: number; privacy: string }>
  granted: string[]
}) {
  const calls: Call[] = []
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
  const client = { request } as unknown as GitHubClient
  const patches = () => calls.filter((c) => c.options?.method === "PATCH")
  return { client, calls, patches }
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
  it("refuses a team that holds the config-repo grant: it is another classroom's staff team", async () => {
    // Classroom `cs101-ta`'s student slug is `cs101`'s TA slug. Adopting the TA
    // team as students would flip it secret and write the secret onto it.
    const { client, patches } = makeOrg({
      existing: { "classroom50-cs101-ta": { id: 7, privacy: "closed" } },
      granted: ["classroom50-cs101-ta"],
    })
    const err = await ensureClassroomTeam(client, "acme", "cs101-ta").catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(UnclaimedTeamError)
    expect((err as UnclaimedTeamError).localized.key).toBe(
      "staffTeams.unclaimed.student",
    )
    expect(patches()).toEqual([])
  })

  it("adopts an ungranted team as the student team", async () => {
    const { client } = makeOrg({
      existing: { "classroom50-cs101": { id: 7, privacy: "secret" } },
      granted: [],
    })
    const team = await ensureClassroomTeam(client, "acme", "cs101")
    expect(team).toEqual({ id: 7, slug: "classroom50-cs101", created: false })
  })
})
