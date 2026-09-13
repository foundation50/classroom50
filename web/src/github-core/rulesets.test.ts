import { describe, expect, it, vi } from "vitest"

import {
  RULESET_NAME_FEEDBACK_BASE,
  RULESET_NAME_SUBMISSION_HISTORY,
  auditRulesets,
  checkRulesets,
  classroomRulesetBodies,
  collectBypassStaffTeamIds,
  collectStaffTeams,
  feedbackBaseBypassActors,
  prepareStaffTeams,
  repairRulesets,
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
) {
  const calls: Recorded[] = []
  const request = vi
    .fn()
    .mockImplementation(
      (path: string, options?: { method?: string; body?: unknown }) => {
        const method = options?.method ?? "GET"
        calls.push({ method, path, body: options?.body })
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

describe("checkRulesets", () => {
  it("enforced when both rulesets exist and every staff team is exempt", async () => {
    const { client } = makeClient(
      [
        { id: 10, name: RULESET_NAME_SUBMISSION_HISTORY },
        { id: 20, name: RULESET_NAME_FEEDBACK_BASE },
      ],
      [OWNER_EXEMPT, team(1), team(2)],
    )
    expect((await checkRulesets(client, "acme", [1, 2])).state).toBe("enforced")
  })

  it("reads the ruleset body even with no staff teams: an `always` owner is a drift", async () => {
    const { client, calls } = makeClient(
      [
        { id: 10, name: RULESET_NAME_SUBMISSION_HISTORY },
        { id: 20, name: RULESET_NAME_FEEDBACK_BASE },
      ],
      [{ actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" }],
    )
    const verdict = await checkRulesets(client, "acme", [])
    expect(calls.some((c) => c.path.endsWith("/20"))).toBe(true)
    expect(verdict.state).toBe("unenforced")
    expect(verdict.detail?.key).toBe(
      "orgSettings.audit.detail.rulesetOwnerNotExempt",
    )
  })

  it("unenforced when an actor we did not install sits on the bypass list", async () => {
    const { client } = makeClient(
      [
        { id: 10, name: RULESET_NAME_SUBMISSION_HISTORY },
        { id: 20, name: RULESET_NAME_FEEDBACK_BASE },
      ],
      [OWNER_EXEMPT, team(1), team(99)],
    )
    const verdict = await checkRulesets(client, "acme", [1])
    expect(verdict.detail).toEqual({
      key: "orgSettings.audit.detail.rulesetUnexpectedBypass",
      params: { count: 1 },
    })
  })

  it("unreadable, never enforced, when the classroom list could not be read", async () => {
    const { client, calls } = makeClient([
      { id: 10, name: RULESET_NAME_SUBMISSION_HISTORY },
      { id: 20, name: RULESET_NAME_FEEDBACK_BASE },
    ])
    const verdict = await checkRulesets(client, "acme", null)
    expect(verdict.state).toBe("unreadable")
    expect(calls).toHaveLength(0)
  })

  it("unenforced when a ruleset is missing", async () => {
    const { client } = makeClient([
      { id: 10, name: RULESET_NAME_SUBMISSION_HISTORY },
    ])
    const verdict = await checkRulesets(client, "acme", [])
    expect(verdict.state).toBe("unenforced")
    expect(verdict.detail?.key).toBe("orgSettings.audit.detail.rulesetsMissing")
    expect(String(verdict.detail?.params?.names)).toContain(
      RULESET_NAME_FEEDBACK_BASE,
    )
  })

  it("unenforced when a staff team is missing from the bypass list or not exempt", async () => {
    const { client } = makeClient(
      [
        { id: 10, name: RULESET_NAME_SUBMISSION_HISTORY },
        { id: 20, name: RULESET_NAME_FEEDBACK_BASE },
      ],
      [
        OWNER_EXEMPT,
        team(1),
        { actor_id: 2, actor_type: "Team", bypass_mode: "always" },
      ],
    )
    const verdict = await checkRulesets(client, "acme", [1, 2, 3])
    expect(verdict.state).toBe("unenforced")
    expect(verdict.detail).toEqual({
      key: "orgSettings.audit.detail.rulesetStaffTeamsMissing",
      params: { count: 2 },
    })
  })
})

// A fake org for the collector/prepare path: a config repo with classroom
// dirs, per-classroom classroom.json bodies, live teams (slug -> {id,
// privacy}), and an installed feedback-base ruleset.
function makeConfigRepoClient(opts: {
  classrooms?: Record<string, unknown | null> // null: dir without classroom.json
  teams?: Record<string, { id: number; privacy: string }>
  listingError?: Error
  rulesetTeams?: number[]
}) {
  const calls: Recorded[] = []
  const request = vi.fn(
    async (
      path: string,
      options?: { method?: string; body?: unknown },
    ): Promise<unknown> => {
      const method = options?.method ?? "GET"
      calls.push({ method, path, body: options?.body })
      const teamGet = path.match(/^\/orgs\/acme\/teams\/([^/]+)$/)
      if (teamGet) {
        const t = opts.teams?.[teamGet[1]]
        if (!t) throw httpError(404)
        if (method === "PATCH") return {}
        return { id: t.id, slug: teamGet[1], privacy: t.privacy }
      }
      if (method === "GET" && /\/rulesets\/\d+$/.test(path)) {
        return {
          id: 20,
          name: RULESET_NAME_FEEDBACK_BASE,
          bypass_actors: [OWNER_EXEMPT, ...(opts.rulesetTeams ?? []).map(team)],
        }
      }
      if (method === "GET" && path.includes("/rulesets")) {
        return [
          { id: 10, name: RULESET_NAME_SUBMISSION_HISTORY },
          { id: 20, name: RULESET_NAME_FEEDBACK_BASE },
        ]
      }
      return {}
    },
  )
  const requestRaw = vi.fn(async (path: string): Promise<string> => {
    if (path.includes("/classroom50/contents/") && path.endsWith(".json")) {
      const name = path.split("/contents/")[1].split("/")[0]
      const body = opts.classrooms?.[name]
      if (body === undefined || body === null) throw httpError(404)
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

const cs101 = {
  short_name: "cs101",
  team: { id: 100, slug: "classroom50-cs101" },
  teams: {
    teacher: { id: 11, slug: "classroom50-cs101-teacher" },
    hta: { id: 12, slug: "classroom50-cs101-hta" },
    // A head TA pointing `teams.ta` at the student team.
    ta: { id: 100, slug: "classroom50-cs101" },
  },
}

describe("collectStaffTeams", () => {
  it("keeps only canonical refs; a dir without classroom.json is skipped", async () => {
    const { client } = makeConfigRepoClient({
      classrooms: { cs101, empty: null },
    })
    expect(await collectStaffTeams(client, "acme")).toEqual([
      { id: 11, slug: "classroom50-cs101-teacher" },
      { id: 12, slug: "classroom50-cs101-hta" },
    ])
  })

  it("resolves to [] on a fresh org (no config repo)", async () => {
    const { client } = makeConfigRepoClient({})
    expect(await collectStaffTeams(client, "acme")).toEqual([])
  })

  it("throws on any other listing failure rather than returning a shorter list", async () => {
    const { client } = makeConfigRepoClient({ listingError: httpError(500) })
    await expect(collectStaffTeams(client, "acme")).rejects.toThrow()
  })
})

describe("prepareStaffTeams", () => {
  it("patches secret teams, uses live ids, and leaves a deleted team out", async () => {
    const { client, calls } = makeConfigRepoClient({
      teams: {
        "classroom50-cs101-teacher": { id: 11, privacy: "secret" },
        // Re-created under the same slug: live id differs from the record.
        "classroom50-cs101-hta": { id: 120, privacy: "closed" },
      },
    })
    const ids = await prepareStaffTeams(client, "acme", [
      { id: 11, slug: "classroom50-cs101-teacher" },
      { id: 12, slug: "classroom50-cs101-hta" },
      { id: 13, slug: "classroom50-cs101-ta" }, // gone on GitHub
    ])
    expect(ids).toEqual([11, 120])
    const patches = calls.filter((c) => c.method === "PATCH").map((c) => c.path)
    expect(patches).toEqual(["/orgs/acme/teams/classroom50-cs101-teacher"])
  })

  it("propagates a rate limit instead of silently shrinking the list", async () => {
    const request = vi.fn(async () => {
      throw httpError(403, true)
    })
    const client = { request } as unknown as GitHubClient
    await expect(
      prepareStaffTeams(client, "acme", [{ id: 1, slug: "classroom50-x-ta" }]),
    ).rejects.toThrow()
  })
})

describe("collectBypassStaffTeamIds -> repairRulesets fail-closed", () => {
  it("returns null when the classroom list can't be read, and repair keeps the current teams", async () => {
    const { client, calls } = makeConfigRepoClient({
      listingError: httpError(500),
      rulesetTeams: [7, 8],
    })
    const ids = await collectBypassStaffTeamIds(client, "acme")
    expect(ids).toBeNull()
    const result = await repairRulesets(client, "acme", ids)
    expect(result.status).toBe("warning")
    const put = calls.find((c) => c.method === "PUT" && c.path.endsWith("/20"))
    expect(
      (put?.body as { bypass_actors: RulesetBypassActor[] }).bypass_actors,
    ).toEqual([OWNER_EXEMPT, team(7), team(8)])
  })

  it("auditRulesets reports unreadable on a collector failure", async () => {
    const { client } = makeConfigRepoClient({ listingError: httpError(500) })
    expect((await auditRulesets(client, "acme")).state).toBe("unreadable")
  })
})
