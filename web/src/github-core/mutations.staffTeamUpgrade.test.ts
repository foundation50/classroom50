import { describe, expect, it, vi } from "vitest"

import { ensureStaffTeams } from "./mutations"
import { RULESET_NAME_FEEDBACK_BASE } from "./rulesets"
import { GitHubAPIError } from "./errors"
import type { GitHubClient, GitHubRequestOptions } from "./client"

// The classroom reconcile calls ensureStaffTeams on every owner visit. For a
// classroom created by an older release that is the upgrade path: its staff
// teams were `secret` and are on no bypass list, and after one visit they must
// be `closed` (GitHub rejects a secret team as a bypass actor) and exempt from
// the feedback-base lock so staff can merge feedback PRs.

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

// An org with three pre-existing secret staff teams (ids 11, 12, 13) and the
// feedback-base ruleset installed with only the owner exempt.
function makeLegacyOrg(opts: { rulesetInstalled: boolean }) {
  const calls: Call[] = []
  const ids: Record<string, number> = {
    "classroom50-cs101-teacher": 11,
    "classroom50-cs101-hta": 12,
    "classroom50-cs101-ta": 13,
  }
  const request = vi.fn(
    async (path: string, options?: GitHubRequestOptions): Promise<unknown> => {
      calls.push({ path, options })
      const method = options?.method ?? "GET"
      if (path === "/orgs/acme/teams" && method === "POST") throw apiError(422)
      const teamGet = path.match(/^\/orgs\/acme\/teams\/([^/]+)$/)
      if (teamGet && method === "GET") {
        return {
          id: ids[teamGet[1]],
          slug: teamGet[1],
          privacy: "secret",
          notification_setting: "notifications_enabled",
        }
      }
      if (teamGet && method === "PATCH") return undefined
      // Every legacy staff team holds its config-repo grant: that is what
      // proves it is Classroom 50's and lets the adopt reshape it.
      if (
        /^\/orgs\/acme\/teams\/[^/]+\/repos\/acme\/classroom50$/.test(path) &&
        method === "GET"
      ) {
        return undefined
      }
      if (path.startsWith("/orgs/acme/rulesets?") && method === "GET") {
        return opts.rulesetInstalled
          ? [{ id: 7, name: RULESET_NAME_FEEDBACK_BASE }]
          : []
      }
      if (path === "/orgs/acme/rulesets/7" && method === "GET") {
        return {
          id: 7,
          name: RULESET_NAME_FEEDBACK_BASE,
          bypass_actors: [
            {
              actor_id: 1,
              actor_type: "OrganizationAdmin",
              bypass_mode: "exempt",
            },
          ],
        }
      }
      if (path === "/orgs/acme/rulesets/7" && method === "PUT") return {}
      throw new Error(`unexpected ${method} ${path}`)
    },
  )
  // No classroom `cs101-<role>` exists: the adopt guard's sibling probe 404s.
  const requestRaw = vi.fn(async (): Promise<string> => {
    throw apiError(404)
  })
  const client = { request, requestRaw } as unknown as GitHubClient
  return { client, calls }
}

describe("ensureStaffTeams on a classroom from an older release", () => {
  it("makes each secret staff team closed and exempts all three in one PUT", async () => {
    const { client, calls } = makeLegacyOrg({ rulesetInstalled: true })
    const result = await ensureStaffTeams(client, "acme", "cs101")

    expect(result.created).toEqual([])
    expect(result.teams).toEqual({
      teacher: { id: 11, slug: "classroom50-cs101-teacher" },
      hta: { id: 12, slug: "classroom50-cs101-hta" },
      ta: { id: 13, slug: "classroom50-cs101-ta" },
    })

    const privacyPatches = calls
      .filter(
        (c) => c.options?.method === "PATCH" && c.path.includes("/teams/"),
      )
      .map((c) => [c.path.split("/teams/")[1], c.options?.body])
    expect(privacyPatches).toEqual([
      ["classroom50-cs101-teacher", { privacy: "closed" }],
      ["classroom50-cs101-hta", { privacy: "closed" }],
      ["classroom50-cs101-ta", { privacy: "closed" }],
    ])

    const puts = calls.filter((c) => c.options?.method === "PUT")
    expect(puts.map((c) => c.path)).toEqual(["/orgs/acme/rulesets/7"])
    const body = puts[0].options?.body as {
      bypass_actors: { actor_id: number; bypass_mode: string }[]
    }
    expect(body.bypass_actors.map((a) => [a.actor_id, a.bypass_mode])).toEqual([
      [1, "exempt"],
      [11, "exempt"],
      [12, "exempt"],
      [13, "exempt"],
    ])
  })

  it("still heals visibility when the ruleset isn't installed, without throwing", async () => {
    const { client, calls } = makeLegacyOrg({ rulesetInstalled: false })
    await expect(
      ensureStaffTeams(client, "acme", "cs101"),
    ).resolves.toBeDefined()
    expect(calls.filter((c) => c.options?.method === "PATCH").length).toBe(3)
    expect(calls.some((c) => c.options?.method === "PUT")).toBe(false)
  })
})
