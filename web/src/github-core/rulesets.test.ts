import { describe, expect, it, vi } from "vitest"

import {
  RULESET_NAME_FEEDBACK_BASE,
  RULESET_NAME_SUBMISSION_HISTORY,
  auditRulesets,
  classroomRulesetBodies,
  collectBypassStaffTeamIds,
  collectStaffTeamSlugs,
  feedbackBaseBypassActors,
  prepareStaffTeams,
  repairRulesets,
  revokeClassroomStaffTeams,
  updateFeedbackBaseBypassTeams,
  type RulesetBypassActor,
} from "./rulesets"
import { GitHubAPIError } from "./errors"
import type { GitHubClient } from "./client"

// The two org rulesets mirror the CLI: submission-history (default branch,
// non_fast_forward + deletion, owners bypass `always`) and feedback-base-lock
// (refs/heads/feedback, update + deletion, owners and every classroom staff
// team `exempt`). Reconcile is create-or-PUT-by-name. The fake client records
// POST/PUT calls and can serve the installed feedback-base ruleset's actors.

type Recorded = { method: string; path: string; body: unknown }

function makeClient(
  existing: Array<{ id: number; name: string }>,
  feedbackActors: RulesetBypassActor[] = [],
  // slug -> id for GET /orgs/acme/teams/{slug}; an unlisted slug 404s.
  liveTeams: Record<string, number> = {},
) {
  const calls: Recorded[] = []
  const request = vi
    .fn()
    .mockImplementation(
      (path: string, options?: { method?: string; body?: unknown }) => {
        const method = options?.method ?? "GET"
        calls.push({ method, path, body: options?.body })
        const teamGet = path.match(/^\/orgs\/acme\/teams\/([^/]+)$/)
        if (method === "GET" && teamGet) {
          const id = liveTeams[teamGet[1]]
          if (id === undefined) return Promise.reject(httpError(404))
          return Promise.resolve({ id, slug: teamGet[1] })
        }
        if (method === "GET" && /\/rulesets\/\d+$/.test(path)) {
          const id = Number(path.split("/").pop())
          const rs = existing.find((r) => r.id === id)
          return Promise.resolve({ ...rs, bypass_actors: feedbackActors })
        }
        if (method === "GET" && path.includes("/rulesets")) {
          // Single page; <100 ends pagination.
          return Promise.resolve(existing)
        }
        return Promise.resolve({})
      },
    )
  const client: GitHubClient = {
    request: request as unknown as GitHubClient["request"],
    requestRaw: () => Promise.reject(new Error("unexpected requestRaw")),
    fetchArchive: () => Promise.reject(new Error("unexpected fetchArchive")),
  }
  return { client, calls }
}

const OWNER_EXEMPT: RulesetBypassActor = {
  actor_id: 1,
  actor_type: "OrganizationAdmin",
  bypass_mode: "exempt",
}
const team = (id: number): RulesetBypassActor => ({
  actor_id: id,
  actor_type: "Team",
  bypass_mode: "exempt",
})

describe("classroomRulesetBodies", () => {
  it("defines the two rulesets exactly as the CLI does", () => {
    const [submission, feedback] = classroomRulesetBodies([30, 10, 20, 10, 0])

    expect(submission.name).toBe(RULESET_NAME_SUBMISSION_HISTORY)
    expect(submission.conditions.ref_name.include).toEqual(["~DEFAULT_BRANCH"])
    expect(submission.rules.map((r) => r.type)).toEqual([
      "non_fast_forward",
      "deletion",
    ])
    // Rewriting a student's history stays a deliberate, audited bypass.
    expect(submission.bypass_actors).toEqual([
      { actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" },
    ])

    expect(feedback.name).toBe(RULESET_NAME_FEEDBACK_BASE)
    expect(feedback.conditions.ref_name.include).toEqual([
      "refs/heads/feedback",
    ])
    // `update` (not a review rule) is what keeps a student from ever moving
    // the frozen base; creation is left allowed for accept and the runner.
    expect(feedback.rules.map((r) => r.type)).toEqual(["update", "deletion"])
    // Owners and staff teams are exempt (rules not evaluated → plain Merge
    // button); team ids deduped, sorted, non-positive dropped.
    expect(feedback.bypass_actors).toEqual([
      OWNER_EXEMPT,
      team(10),
      team(20),
      team(30),
    ])

    for (const rs of [submission, feedback]) {
      expect(rs.target).toBe("branch")
      expect(rs.enforcement).toBe("active")
      expect(rs.conditions.repository_name.include).toEqual(["~ALL"])
    }
  })

  it("exempts owners even with no staff teams", () => {
    expect(feedbackBaseBypassActors([])).toEqual([OWNER_EXEMPT])
  })
})

describe("repairRulesets", () => {
  it("POSTs both rulesets when neither exists, carrying the staff teams", async () => {
    const { client, calls } = makeClient([])
    const result = await repairRulesets(client, "acme", [7, 8])
    const posts = calls.filter((c) => c.method === "POST")
    expect(posts).toHaveLength(2)
    expect(calls.some((c) => c.method === "PUT")).toBe(false)
    expect(result.status).toBe("complete")
    expect(result.created).toHaveLength(2)
    const feedback = posts
      .map(
        (c) => c.body as { name: string; bypass_actors: RulesetBypassActor[] },
      )
      .find((b) => b.name === RULESET_NAME_FEEDBACK_BASE)
    expect(feedback?.bypass_actors).toEqual([OWNER_EXEMPT, team(7), team(8)])
  })

  it("PUTs over existing rulesets (reconcile by name), rebuilding the bypass list", async () => {
    const { client, calls } = makeClient(
      [
        { id: 10, name: RULESET_NAME_SUBMISSION_HISTORY },
        { id: 20, name: RULESET_NAME_FEEDBACK_BASE },
      ],
      [OWNER_EXEMPT, team(99)],
    )
    const result = await repairRulesets(client, "acme", [5])
    const puts = calls.filter((c) => c.method === "PUT")
    expect(puts).toHaveLength(2)
    expect(puts.map((c) => c.path)).toContain("/orgs/acme/rulesets/10")
    expect(puts.map((c) => c.path)).toContain("/orgs/acme/rulesets/20")
    expect(calls.some((c) => c.method === "POST")).toBe(false)
    expect(result.updated).toHaveLength(2)
    // A stale team (99, from a deleted classroom) is replaced, not merged.
    const feedback = puts.find((c) => c.path.endsWith("/20"))?.body as {
      bypass_actors: RulesetBypassActor[]
    }
    expect(feedback.bypass_actors).toEqual([OWNER_EXEMPT, team(5)])
  })

  it("creates the missing one and updates the existing one", async () => {
    const { client, calls } = makeClient([
      { id: 10, name: RULESET_NAME_SUBMISSION_HISTORY },
    ])
    const result = await repairRulesets(client, "acme", [])
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1)
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1)
    expect(result.created).toEqual([RULESET_NAME_FEEDBACK_BASE])
    expect(result.updated).toEqual([RULESET_NAME_SUBMISSION_HISTORY])
  })

  it("warns and continues when one create fails", async () => {
    const request = vi
      .fn()
      .mockImplementation((path: string, options?: { method?: string }) => {
        const method = options?.method ?? "GET"
        if (method === "GET") return Promise.resolve([])
        if (method === "POST" && path.endsWith("/rulesets")) {
          // Fail the first POST, succeed the second.
          if (
            request.mock.calls.filter(
              (c) => (c[1] as { method?: string })?.method === "POST",
            ).length === 1
          ) {
            return Promise.reject(new Error("boom"))
          }
        }
        return Promise.resolve({})
      })
    const client: GitHubClient = {
      request: request as unknown as GitHubClient["request"],
      requestRaw: () => Promise.reject(new Error("x")),
      fetchArchive: () => Promise.reject(new Error("x")),
    }
    const result = await repairRulesets(client, "acme", [])
    expect(result.status).toBe("warning")
    expect(result.failed).toHaveLength(1)
    expect(result.created).toHaveLength(1)
    // A bare Error is a dropped connection, not a GitHub refusal: retryable.
    expect(result.transient).toBe(true)
  })

  it("classifies a refused write by its status: 5xx retryable, 403 not", async () => {
    for (const [status, transient] of [
      [502, true],
      [403, false],
    ] as const) {
      const request = vi
        .fn()
        .mockImplementation((_path: string, options?: { method?: string }) => {
          const method = options?.method ?? "GET"
          if (method === "GET") return Promise.resolve([])
          return Promise.reject(httpError(status))
        })
      const client: GitHubClient = {
        request: request as unknown as GitHubClient["request"],
        requestRaw: () => Promise.reject(new Error("x")),
        fetchArchive: () => Promise.reject(new Error("x")),
      }
      const result = await repairRulesets(client, "acme", [])
      expect(result.reason).toBe("apply_failed")
      expect(result.transient).toBe(transient)
    }
  })
})

describe("updateFeedbackBaseBypassTeams", () => {
  it("merges add and remove into the existing Team actors and PUTs the full body", async () => {
    const { client, calls } = makeClient(
      [{ id: 20, name: RULESET_NAME_FEEDBACK_BASE }],
      [OWNER_EXEMPT, team(10), team(20)],
    )
    const ok = await updateFeedbackBaseBypassTeams(client, "acme", {
      add: [30],
      remove: [10],
    })
    expect(ok).toBe(true)
    const put = calls.find((c) => c.method === "PUT")
    expect(put?.path).toBe("/orgs/acme/rulesets/20")
    const body = put?.body as {
      rules: { type: string }[]
      bypass_actors: RulesetBypassActor[]
    }
    expect(body.bypass_actors).toEqual([OWNER_EXEMPT, team(20), team(30)])
    expect(body.rules.map((r) => r.type)).toEqual(["update", "deletion"])
  })

  it("skips the PUT when every team is already exempt", async () => {
    // Runs on every classroom visit, so the common case must be read-only.
    const { client, calls } = makeClient(
      [{ id: 20, name: RULESET_NAME_FEEDBACK_BASE }],
      [OWNER_EXEMPT, team(10), team(20)],
    )
    const ok = await updateFeedbackBaseBypassTeams(client, "acme", {
      add: [20, 10],
    })
    expect(ok).toBe(true)
    expect(calls.some((c) => c.method === "PUT")).toBe(false)
  })

  it("PUTs when a team is listed but not exempt (older `always` entry)", async () => {
    const { client, calls } = makeClient(
      [{ id: 20, name: RULESET_NAME_FEEDBACK_BASE }],
      [
        OWNER_EXEMPT,
        { actor_id: 10, actor_type: "Team", bypass_mode: "always" },
      ],
    )
    await updateFeedbackBaseBypassTeams(client, "acme", { add: [10] })
    const put = calls.find((c) => c.method === "PUT")
    expect(
      (put?.body as { bypass_actors: RulesetBypassActor[] }).bypass_actors,
    ).toEqual([OWNER_EXEMPT, team(10)])
  })

  it("is a no-op when the ruleset isn't installed", async () => {
    const { client, calls } = makeClient([])
    const ok = await updateFeedbackBaseBypassTeams(client, "acme", {
      add: [30],
    })
    expect(ok).toBe(false)
    expect(calls.some((c) => c.method === "PUT")).toBe(false)
  })
})

describe("revokeClassroomStaffTeams", () => {
  it("drops the live team at each of the classroom's staff slugs, recorded or not", async () => {
    // The recorded `teams` block is never consulted: the unrecorded ta team is
    // dropped, the other classroom's team is kept, and an unstaffed role (no
    // hta team) is skipped.
    const { client, calls } = makeClient(
      [{ id: 20, name: RULESET_NAME_FEEDBACK_BASE }],
      [OWNER_EXEMPT, team(10), team(20), team(30)],
      {
        "classroom50-cs101-teacher": 10,
        "classroom50-cs101-ta": 30,
        "classroom50-other-teacher": 20,
      },
    )
    await revokeClassroomStaffTeams(client, "acme", ["cs101"])
    const put = calls.find((c) => c.method === "PUT")
    expect(
      (put?.body as { bypass_actors: RulesetBypassActor[] }).bypass_actors,
    ).toEqual([OWNER_EXEMPT, team(20)])
  })

  it("is a no-op when no team exists at any of the slugs", async () => {
    const { client, calls } = makeClient(
      [{ id: 20, name: RULESET_NAME_FEEDBACK_BASE }],
      [OWNER_EXEMPT, team(10)],
    )
    await revokeClassroomStaffTeams(client, "acme", ["cs101"])
    expect(calls.some((c) => c.method === "PUT")).toBe(false)
  })
})

// A fake org for the collector/audit/repair path: a config repo with
// classroom dirs, per-classroom classroom.json bodies, the teams that hold a
// grant on the config repo (slug -> {id, privacy}), and the installed
// rulesets' feedback-base actors. A team with no grant is simply not listed,
// whatever slug it sits at; the org-wide team listing is never consulted.
function makeConfigRepoClient(opts: {
  classrooms?: Record<string, unknown | null> // null: dir without classroom.json
  teams?: Record<string, { id: number; privacy: string }>
  teamsError?: Error
  listingError?: Error
  installed?: Array<{ id: number; name: string }>
  feedbackActors?: RulesetBypassActor[]
  rulesetsError?: Error
}) {
  const calls: Recorded[] = []
  const installed = opts.installed ?? [
    { id: 10, name: RULESET_NAME_SUBMISSION_HISTORY },
    { id: 20, name: RULESET_NAME_FEEDBACK_BASE },
  ]
  const request = vi.fn(
    async (
      path: string,
      options?: { method?: string; body?: unknown },
    ): Promise<unknown> => {
      const method = options?.method ?? "GET"
      calls.push({ method, path, body: options?.body })
      if (method === "GET" && /^\/orgs\/acme\/teams\?/.test(path)) {
        throw new Error(
          "the org-wide team listing must not be read: it cannot tell a staff team from a squatter at its slug",
        )
      }
      if (
        method === "GET" &&
        /^\/repos\/acme\/classroom50\/teams\?/.test(path)
      ) {
        if (opts.teamsError) throw opts.teamsError
        if (!opts.classrooms && !opts.teams) throw httpError(404)
        // Single page; <100 ends pagination.
        return Object.entries(opts.teams ?? {}).map(([slug, t]) => ({
          id: t.id,
          slug,
          privacy: t.privacy,
          permission: "pull",
        }))
      }
      if (method === "PATCH" && /^\/orgs\/acme\/teams\/[^/]+$/.test(path)) {
        if (path.endsWith("-stuck-teacher")) throw httpError(403)
        return {}
      }
      if (method === "GET" && path.includes("/rulesets")) {
        if (opts.rulesetsError) throw opts.rulesetsError
        if (/\/rulesets\/\d+$/.test(path)) {
          return {
            id: 20,
            name: RULESET_NAME_FEEDBACK_BASE,
            bypass_actors: opts.feedbackActors ?? [OWNER_EXEMPT],
          }
        }
        return installed
      }
      return {}
    },
  )
  const requestRaw = vi.fn(async (path: string): Promise<string> => {
    if (path.includes("/classroom50/contents/") && path.endsWith(".json")) {
      const name = path.split("/contents/")[1].split("/")[0]
      const body = opts.classrooms?.[name]
      if (body === undefined || body === null) throw httpError(404)
      if (body === "BOOM") throw httpError(500)
      if (body === "MALFORMED") return "{ not json"
      if (body === "TIMEOUT")
        throw new DOMException("timed out", "TimeoutError")
      return JSON.stringify(body)
    }
    if (path.includes("/classroom50/contents")) {
      if (opts.listingError) throw opts.listingError
      if (!opts.classrooms) throw httpError(404)
      return JSON.stringify(
        Object.keys(opts.classrooms).map((name) => ({ name, type: "dir" })),
      )
    }
    throw new Error(`unexpected requestRaw ${path}`)
  })
  const client = { request, requestRaw } as unknown as GitHubClient
  return { client, calls }
}

function httpError(status: number, rateLimited = false): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: "x",
    message: "err",
    body: null,
    rateLimit: {
      limit: null,
      remaining: rateLimited ? 0 : null,
      used: null,
      reset: rateLimited ? 9_999_999_999 : null,
      resource: null,
      retryAfter: rateLimited ? 60 : null,
    },
  })
}

// A classroom whose head TA pointed `teams.ta` at the student team. The slug
// walk never reads the teams block, so the tampering changes nothing, and the
// student team holds no config-repo grant, so it is never in the listing.
const cs101 = {
  short_name: "cs101",
  team: { id: 100, slug: "classroom50-cs101" },
  teams: {
    teacher: { id: 11, slug: "classroom50-cs101-teacher" },
    hta: { id: 12, slug: "classroom50-cs101-hta" },
    ta: { id: 100, slug: "classroom50-cs101" },
  },
}
const CS101_SLUGS = [
  "classroom50-cs101-teacher",
  "classroom50-cs101-hta",
  "classroom50-cs101-ta",
]
const cs101Teams = {
  "classroom50-cs101-teacher": { id: 11, privacy: "closed" },
  "classroom50-cs101-hta": { id: 12, privacy: "closed" },
}

describe("auditRulesets", () => {
  it("enforced when both rulesets exist and every live staff team is exempt", async () => {
    const { client } = makeConfigRepoClient({
      classrooms: { cs101 },
      teams: cs101Teams,
      feedbackActors: [OWNER_EXEMPT, team(11), team(12)],
    })
    expect((await auditRulesets(client, "acme")).state).toBe("enforced")
  })

  it("expects a staff team the classroom.json never recorded (created by a role flow)", async () => {
    const { client } = makeConfigRepoClient({
      classrooms: { cs101: { short_name: "cs101" } },
      teams: cs101Teams,
      feedbackActors: [OWNER_EXEMPT, team(11)],
    })
    const verdict = await auditRulesets(client, "acme")
    expect(verdict.state).toBe("unenforced")
    expect(verdict.detail).toEqual({
      key: "orgSettings.audit.detail.rulesetStaffTeamsMissing",
      params: { count: 1 },
    })
  })

  it("reads the ruleset body even with no staff teams: an `always` owner is a drift", async () => {
    const { client, calls } = makeConfigRepoClient({
      feedbackActors: [
        { actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" },
      ],
    })
    const verdict = await auditRulesets(client, "acme")
    expect(calls.some((c) => c.path.endsWith("/20"))).toBe(true)
    expect(verdict.state).toBe("unenforced")
    expect(verdict.detail?.key).toBe(
      "orgSettings.audit.detail.rulesetOwnerNotExempt",
    )
  })

  it("unenforced when an actor we did not install sits on the bypass list", async () => {
    const { client } = makeConfigRepoClient({
      classrooms: { cs101 },
      teams: cs101Teams,
      feedbackActors: [OWNER_EXEMPT, team(11), team(12), team(99)],
    })
    const verdict = await auditRulesets(client, "acme")
    expect(verdict.detail).toEqual({
      key: "orgSettings.audit.detail.rulesetUnexpectedBypass",
      params: { count: 1 },
    })
  })

  it("unenforced when a ruleset is missing", async () => {
    const { client } = makeConfigRepoClient({
      installed: [{ id: 10, name: RULESET_NAME_SUBMISSION_HISTORY }],
    })
    const verdict = await auditRulesets(client, "acme")
    expect(verdict.state).toBe("unenforced")
    expect(verdict.detail?.key).toBe("orgSettings.audit.detail.rulesetsMissing")
    expect(String(verdict.detail?.params?.names)).toContain(
      RULESET_NAME_FEEDBACK_BASE,
    )
  })

  it("unenforced when a staff team is missing from the bypass list or not exempt", async () => {
    const { client } = makeConfigRepoClient({
      classrooms: { cs101 },
      teams: {
        ...cs101Teams,
        "classroom50-cs101-ta": { id: 13, privacy: "secret" },
      },
      feedbackActors: [
        OWNER_EXEMPT,
        team(11),
        { actor_id: 12, actor_type: "Team", bypass_mode: "always" },
      ],
    })
    const verdict = await auditRulesets(client, "acme")
    expect(verdict.state).toBe("unenforced")
    // 12 is not exempt; 13 (still secret, but live) is expected too.
    expect(verdict.detail).toEqual({
      key: "orgSettings.audit.detail.rulesetStaffTeamsMissing",
      params: { count: 2 },
    })
  })

  it("unreadable with the read-failure detail when the ruleset itself can't be read", async () => {
    const { client } = makeConfigRepoClient({
      classrooms: { cs101 },
      teams: cs101Teams,
      rulesetsError: httpError(403),
    })
    const verdict = await auditRulesets(client, "acme")
    expect(verdict.state).toBe("unreadable")
    expect(verdict.detail?.key).not.toBe(
      "orgSettings.audit.detail.rulesetStaffTeamsUnreadable",
    )
  })

  it("unreadable, never enforced, when the classroom list or the team listing fails", async () => {
    for (const opts of [
      { listingError: httpError(500) },
      { classrooms: { cs101 }, teamsError: httpError(500) },
    ]) {
      const { client, calls } = makeConfigRepoClient(opts)
      const verdict = await auditRulesets(client, "acme")
      expect(verdict.state).toBe("unreadable")
      expect(verdict.detail?.key).toBe(
        "orgSettings.audit.detail.rulesetStaffTeamsUnreadable",
      )
      expect(calls.some((c) => c.method !== "GET")).toBe(false)
    }
  })

  it("names the classroom when one classroom.json is not valid JSON", async () => {
    const { client } = makeConfigRepoClient({
      classrooms: { cs101, broken: "MALFORMED" },
      teams: cs101Teams,
    })
    const verdict = await auditRulesets(client, "acme")
    expect(verdict.state).toBe("unreadable")
    expect(verdict.detail).toEqual({
      key: "orgSettings.audit.detail.rulesetClassroomInvalid",
      params: { classroom: "broken" },
    })
  })

  it("a timed-out classroom.json read stays retryable, never 'invalid JSON'", async () => {
    const { client } = makeConfigRepoClient({
      classrooms: { cs101, slow: "TIMEOUT" },
      teams: cs101Teams,
    })
    const verdict = await auditRulesets(client, "acme")
    expect(verdict.state).toBe("unreadable")
    expect(verdict.detail?.key).toBe(
      "orgSettings.audit.detail.rulesetStaffTeamsUnreadable",
    )
  })
})

describe("collectStaffTeamSlugs", () => {
  it("derives every role's slug per classroom; a dir without classroom.json is skipped", async () => {
    const { client } = makeConfigRepoClient({
      classrooms: { cs101, empty: null },
    })
    expect(await collectStaffTeamSlugs(client, "acme")).toEqual(CS101_SLUGS)
  })

  it("resolves to [] on a fresh org (no config repo)", async () => {
    const { client } = makeConfigRepoClient({})
    expect(await collectStaffTeamSlugs(client, "acme")).toEqual([])
  })

  it("throws on a listing or per-classroom read failure rather than returning a shorter list", async () => {
    const listing = makeConfigRepoClient({ listingError: httpError(500) })
    await expect(
      collectStaffTeamSlugs(listing.client, "acme"),
    ).rejects.toThrow()
    const oneBad = makeConfigRepoClient({ classrooms: { cs101, bad: "BOOM" } })
    await expect(collectStaffTeamSlugs(oneBad.client, "acme")).rejects.toThrow()
  })
})

describe("prepareStaffTeams", () => {
  it("patches secret teams, uses live ids, and leaves an unstaffed role out", async () => {
    const { client, calls } = makeConfigRepoClient({
      teams: {
        "classroom50-cs101-teacher": { id: 11, privacy: "secret" },
        // Re-created under the same slug: live id is what counts.
        "classroom50-cs101-hta": { id: 120, privacy: "closed" },
        "classroom50-stuck-teacher": { id: 31, privacy: "secret" }, // PATCH refused
      },
    })
    const ids = await prepareStaffTeams(client, "acme", [
      ...CS101_SLUGS,
      "classroom50-stuck-teacher",
    ])
    // A team that stays secret is left off: GitHub would 422 the PUT.
    expect(ids).toEqual([11, 120])
    const patches = calls.filter((c) => c.method === "PATCH").map((c) => c.path)
    expect(patches).toEqual([
      "/orgs/acme/teams/classroom50-cs101-teacher",
      "/orgs/acme/teams/classroom50-stuck-teacher",
    ])
  })

  it("propagates a listing failure or rate limit instead of silently shrinking the list", async () => {
    const listing = makeConfigRepoClient({ teamsError: httpError(500) })
    await expect(
      prepareStaffTeams(listing.client, "acme", CS101_SLUGS),
    ).rejects.toThrow()

    const request = vi.fn(async (path: string) => {
      if (path.includes("/teams?"))
        return [{ id: 1, slug: "classroom50-x-ta", privacy: "secret" }]
      throw httpError(403, true)
    })
    const client = { request } as unknown as GitHubClient
    await expect(
      prepareStaffTeams(client, "acme", ["classroom50-x-ta"]),
    ).rejects.toThrow()
  })

  it("a team at a staff slug without the config-repo grant is not staff", async () => {
    // Classroom `cs101-ta`'s student team sits at `cs101`'s TA slug, and any
    // member can create `classroom50-cs101-hta`. Neither holds a grant on the
    // config repo, so neither is listed: no PATCH, no id, whatever the org's
    // team listing would have shown.
    const { client, calls } = makeConfigRepoClient({
      teams: { "classroom50-cs101-teacher": { id: 11, privacy: "closed" } },
    })
    expect(await prepareStaffTeams(client, "acme", CS101_SLUGS)).toEqual([11])
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([])
  })

  it("resolves to [] on a fresh org (no config repo)", async () => {
    const { client } = makeConfigRepoClient({})
    expect(await prepareStaffTeams(client, "acme", CS101_SLUGS)).toEqual([])
  })
})

describe("collectBypassStaffTeamIds -> repairRulesets fail-closed", () => {
  it("returns null when the classroom list can't be read, and repair keeps the current teams", async () => {
    const { client, calls } = makeConfigRepoClient({
      listingError: httpError(500),
      feedbackActors: [OWNER_EXEMPT, team(7), team(8)],
    })
    const ids = await collectBypassStaffTeamIds(client, "acme")
    expect(ids).toBeNull()
    const result = await repairRulesets(client, "acme", ids)
    expect(result.status).toBe("warning")
    expect(result.reason).toBe("staff_teams_unreadable")
    expect(result.updated).toEqual([
      RULESET_NAME_SUBMISSION_HISTORY,
      RULESET_NAME_FEEDBACK_BASE,
    ])
    const put = calls.find((c) => c.method === "PUT" && c.path.endsWith("/20"))
    expect(
      (put?.body as { bypass_actors: RulesetBypassActor[] }).bypass_actors,
    ).toEqual([OWNER_EXEMPT, team(7), team(8)])
  })

  it("still reconciles submission-history when neither source is readable, leaving the feedback lock alone", async () => {
    const { client, calls } = makeConfigRepoClient({
      listingError: httpError(500),
    })
    // Rulesets list fine, but the feedback-base body read fails.
    let bodyReads = 0
    const inner = client.request
    client.request = ((path: string, options?: unknown) => {
      if (
        /\/rulesets\/20$/.test(path) &&
        !(options as { method?: string })?.method
      ) {
        bodyReads++
        return Promise.reject(httpError(500))
      }
      return inner(path, options as never)
    }) as GitHubClient["request"]
    const result = await repairRulesets(client, "acme", null)
    expect(bodyReads).toBe(1)
    expect(result.status).toBe("warning")
    expect(result.reason).toBe("staff_teams_unreadable")
    expect(result.updated).toEqual([RULESET_NAME_SUBMISSION_HISTORY])
    expect(
      calls.some((c) => c.method === "PUT" && c.path.endsWith("/20")),
    ).toBe(false)
  })

  it("Fix it exempts a live staff team the classroom.json never recorded", async () => {
    const { client, calls } = makeConfigRepoClient({
      classrooms: { cs101: { short_name: "cs101" } },
      teams: cs101Teams,
      feedbackActors: [OWNER_EXEMPT],
    })
    const ids = await collectBypassStaffTeamIds(client, "acme")
    expect(ids).toEqual([11, 12])
    await repairRulesets(client, "acme", ids)
    const put = calls.find((c) => c.method === "PUT" && c.path.endsWith("/20"))
    expect(
      (put?.body as { bypass_actors: RulesetBypassActor[] }).bypass_actors,
    ).toEqual([OWNER_EXEMPT, team(11), team(12)])
  })
})
