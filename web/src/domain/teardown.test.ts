import { describe, expect, it, vi } from "vitest"

import {
  TeardownMarkerError,
  TeardownRateLimitError,
  TeardownScopeError,
  executeTeardown,
  formatTeardownResult,
  planTeardown,
  type TeardownResult,
} from "./teardown"
import { GitHubAPIError } from "@/github-core/errors"
import type { GitHubClient } from "@/github-core/client"

// Teardown mirrors the CLI: marker-gated (refuse orgs without classroom50),
// delete ALL org repos, marker deleted last (re-runnable), 403 = scope wall.
// Also deletes the per-classroom team of every classroom in classroom.json
// (only teams a classroom links to — never a stray classroom50-* team). The fake
// client serves the marker probe, repo list, classroom dir listing,
// per-classroom classroom.json, and the team id-match GET + DELETE.

function notFound(): GitHubAPIError {
  return new GitHubAPIError({
    status: 404,
    url: "x",
    message: "Not Found",
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

function forbidden(): GitHubAPIError {
  return new GitHubAPIError({
    status: 403,
    url: "x",
    message: "Forbidden",
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

// A secondary-rate-limit 403: same status as the scope wall, but carries
// rate-limit signal (retryAfter / remaining:0) so isRateLimited is true.
function rateLimited403(): GitHubAPIError {
  return new GitHubAPIError({
    status: 403,
    url: "x",
    message: "Forbidden (secondary rate limit)",
    body: null,
    rateLimit: {
      limit: null,
      remaining: 0,
      used: null,
      reset: null,
      resource: null,
      retryAfter: 0,
    },
  })
}

function serverError(): GitHubAPIError {
  return new GitHubAPIError({
    status: 500,
    url: "x",
    message: "Server Error",
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

// One classroom directory in the classroom50 config repo. `team` is the ref
// persisted in its classroom.json (omit for a pre-feature/teamless classroom).
type ClassroomFixture = {
  dir: string
  team?: { id: number; slug: string }
}

type Opts = {
  markerExists: boolean
  repos: string[]
  deleteForbidden?: boolean
  // Repos that fail every DELETE with the given error kind.
  failRepos?: Record<string, "rate-limit" | "scope" | "server">
  // Classrooms present under classroom50/ (with optional team ref).
  classrooms?: ClassroomFixture[]
  // Team slugs whose DELETE fails with the given error kind.
  failTeams?: Record<string, "rate-limit" | "scope" | "server" | "not-found">
  // Team slugs whose id-match GET reports a different live id (reused slug).
  teamIdMismatch?: Record<string, number>
}

function makeClient(opts: Opts) {
  const deletes: string[] = []
  const teamDeletes: string[] = []
  const classrooms = opts.classrooms ?? []

  const request = vi
    .fn()
    .mockImplementation((path: string, options?: { method?: string }) => {
      const method = options?.method ?? "GET"
      // Team id-match probe (deleteClassroomTeam confirms the live id).
      const teamMatch = path.match(/\/orgs\/[^/]+\/teams\/([^/]+)$/)
      if (method === "GET" && teamMatch) {
        const slug = teamMatch[1]
        const recorded = classrooms.find((c) => c.team?.slug === slug)?.team
        const liveId = opts.teamIdMismatch?.[slug] ?? recorded?.id ?? 1
        return Promise.resolve({ id: liveId })
      }
      // Marker probe / single-repo GET.
      if (method === "GET" && /\/repos\/[^/]+\/classroom50$/.test(path)) {
        return opts.markerExists
          ? Promise.resolve({ name: "classroom50" })
          : Promise.reject(notFound())
      }
      // Org repo list (paginated).
      if (
        method === "GET" &&
        path.includes("/orgs/") &&
        path.includes("/repos")
      ) {
        return Promise.resolve(opts.repos.map((name) => ({ name })))
      }
      // Team delete.
      if (method === "DELETE" && teamMatch) {
        const slug = teamMatch[1]
        const kind = opts.failTeams?.[slug]
        if (kind === "not-found") return Promise.reject(notFound())
        if (kind === "rate-limit") return Promise.reject(rateLimited403())
        if (kind === "scope") return Promise.reject(forbidden())
        if (kind === "server") return Promise.reject(serverError())
        teamDeletes.push(slug)
        return Promise.resolve(undefined)
      }
      // Repo delete.
      if (method === "DELETE") {
        if (opts.deleteForbidden) return Promise.reject(forbidden())
        const repo = path.split("/").pop() ?? ""
        const kind = opts.failRepos?.[repo]
        if (kind === "rate-limit") return Promise.reject(rateLimited403())
        if (kind === "scope") return Promise.reject(forbidden())
        if (kind === "server") return Promise.reject(serverError())
        deletes.push(repo)
        return Promise.resolve(undefined)
      }
      return Promise.reject(new Error(`unexpected: ${method} ${path}`))
    })

  // listClassroomDirs + getClassroomJson go through requestRaw.
  const requestRaw = vi.fn().mockImplementation((path: string) => {
    // Per-classroom classroom.json.
    const jsonMatch = path.match(
      /\/repos\/[^/]+\/classroom50\/contents\/([^/]+)\/classroom\.json/,
    )
    if (jsonMatch) {
      const dir = jsonMatch[1]
      const found = classrooms.find((c) => c.dir === dir)
      if (!found) return Promise.reject(notFound())
      const body: Record<string, unknown> = {
        path: dir,
        term: "2026",
        name: dir,
        short_name: dir,
        org: "acme",
      }
      if (found.team) body.team = found.team
      return Promise.resolve(JSON.stringify(body))
    }
    // Root contents listing (classroom dirs).
    if (/\/repos\/[^/]+\/classroom50\/contents\//.test(path)) {
      const listing = [
        { type: "dir", name: ".github", path: ".github" },
        ...classrooms.map((c) => ({ type: "dir", name: c.dir, path: c.dir })),
      ]
      return Promise.resolve(JSON.stringify(listing))
    }
    return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
  })

  const client: GitHubClient = {
    request: request as unknown as GitHubClient["request"],
    requestRaw: requestRaw as unknown as GitHubClient["requestRaw"],
  }
  return { client, deletes, teamDeletes }
}

// A requestRaw mock for tests that build their own `request` mock inline and
// just need the classroom-dir listing to come back empty (no classrooms).
function emptyClassroomRequestRaw() {
  return vi.fn().mockImplementation((path: string) => {
    if (/\/repos\/[^/]+\/classroom50\/contents\//.test(path)) {
      return Promise.resolve(
        JSON.stringify([{ type: "dir", name: ".github", path: ".github" }]),
      )
    }
    return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
  })
}

describe("planTeardown", () => {
  it("refuses an org without the classroom50 marker repo", async () => {
    const { client } = makeClient({ markerExists: false, repos: [] })
    await expect(planTeardown(client, "acme")).rejects.toBeInstanceOf(
      TeardownMarkerError,
    )
  })

  it("orders the marker repo last in the plan", async () => {
    const { client } = makeClient({
      markerExists: true,
      repos: ["classroom50", "cs101-hw1-alice", "cs101-hw1-bob"],
    })
    const plan = await planTeardown(client, "acme")
    expect(plan.repoNames[plan.repoNames.length - 1]).toBe("classroom50")
    expect(plan.repoNames).toHaveLength(3)
  })

  it("collects each classroom's team ref (deduped, teamless skipped)", async () => {
    const { client } = makeClient({
      markerExists: true,
      repos: ["classroom50"],
      classrooms: [
        { dir: "cs101", team: { id: 11, slug: "classroom50-cs101" } },
        { dir: "math200", team: { id: 22, slug: "classroom50-math200" } },
        { dir: "legacy" }, // no team block
      ],
    })
    const plan = await planTeardown(client, "acme")
    expect(plan.teams.map((t) => t.slug).sort()).toEqual([
      "classroom50-cs101",
      "classroom50-math200",
    ])
  })
})

describe("executeTeardown", () => {
  it("deletes all repos with the marker last", async () => {
    const { client, deletes } = makeClient({
      markerExists: true,
      repos: ["classroom50", "cs101-hw1-alice", "cs101-hw1-bob"],
    })
    const plan = await planTeardown(client, "acme")
    const result = await executeTeardown(client, plan)
    expect(result.deleted).toHaveLength(3)
    expect(result.failed).toHaveLength(0)
    // Marker deleted last.
    expect(deletes[deletes.length - 1]).toBe("classroom50")
  })

  it("surfaces the delete_repo scope wall on a 403", async () => {
    const { client } = makeClient({
      markerExists: true,
      repos: ["classroom50", "cs101-hw1-alice"],
      deleteForbidden: true,
    })
    const plan = await planTeardown(client, "acme")
    await expect(executeTeardown(client, plan)).rejects.toBeInstanceOf(
      TeardownScopeError,
    )
  })

  it("does not throw scope error when there is nothing but the marker", async () => {
    const { client, deletes } = makeClient({
      markerExists: true,
      repos: ["classroom50"],
    })
    const plan = await planTeardown(client, "acme")
    const result = await executeTeardown(client, plan)
    expect(result.deleted).toEqual(["classroom50"])
    expect(deletes).toEqual(["classroom50"])
  })

  it("treats a secondary-rate-limit 403 as retryable, not the scope wall", async () => {
    // A repo that always rate-limits (403 + retryAfter) exhausts retries; it
    // must surface as TeardownRateLimitError, never TeardownScopeError.
    const { client } = makeClient({
      markerExists: true,
      repos: ["classroom50", "cs101-hw1-alice"],
      failRepos: { "cs101-hw1-alice": "rate-limit" },
    })
    const plan = await planTeardown(client, "acme")
    await expect(executeTeardown(client, plan)).rejects.toBeInstanceOf(
      TeardownRateLimitError,
    )
  })

  it("preserves the marker when a non-marker delete fails (re-runnable)", async () => {
    // A non-marker repo fails with a non-403 (500). The marker must NOT be
    // deleted, so a re-run still passes the marker gate.
    const { client, deletes } = makeClient({
      markerExists: true,
      repos: ["classroom50", "cs101-hw1-alice", "cs101-hw1-bob"],
      failRepos: { "cs101-hw1-alice": "server" },
    })
    const plan = await planTeardown(client, "acme")
    const result = await executeTeardown(client, plan)
    expect(result.failed).toContain("cs101-hw1-alice")
    // Marker was preserved (never deleted) because a non-marker delete failed.
    expect(deletes).not.toContain("classroom50")
    expect(result.deleted).not.toContain("classroom50")
  })

  it("re-enumerates at execution so a repo created after planning is still deleted", async () => {
    // The plan is captured when the modal opens; a repo can be created during
    // the type-to-confirm pause. executeTeardown must re-list, not trust it.
    const deletes: string[] = []
    let listCalls = 0
    const request = vi
      .fn()
      .mockImplementation((path: string, options?: { method?: string }) => {
        const method = options?.method ?? "GET"
        if (method === "GET" && /\/repos\/[^/]+\/classroom50$/.test(path)) {
          return Promise.resolve({ name: "classroom50" })
        }
        if (
          method === "GET" &&
          path.includes("/orgs/") &&
          path.includes("/repos")
        ) {
          listCalls++
          // planTeardown sees one repo; by execution a second has appeared.
          const repos =
            listCalls === 1
              ? ["classroom50", "cs101-hw1-alice"]
              : ["classroom50", "cs101-hw1-alice", "cs101-hw1-late"]
          return Promise.resolve(repos.map((name) => ({ name })))
        }
        if (method === "DELETE") {
          deletes.push(path.split("/").pop() ?? "")
          return Promise.resolve(undefined)
        }
        return Promise.reject(new Error(`unexpected: ${method} ${path}`))
      })
    const requestRaw = emptyClassroomRequestRaw()
    const client: GitHubClient = {
      request: request as unknown as GitHubClient["request"],
      requestRaw: requestRaw as unknown as GitHubClient["requestRaw"],
    }
    const plan = await planTeardown(client, "acme")
    expect(plan.repoNames).not.toContain("cs101-hw1-late")
    const result = await executeTeardown(client, plan)
    // The repo created after planning is deleted, and the marker is still last.
    expect(result.deleted).toEqual(
      expect.arrayContaining([
        "cs101-hw1-alice",
        "cs101-hw1-late",
        "classroom50",
      ]),
    )
    expect(deletes[deletes.length - 1]).toBe("classroom50")
  })

  it("retries a transient delete failure and recovers", async () => {
    // First DELETE on the repo fails transiently (500), the retry succeeds.
    let aliceAttempts = 0
    const deletes: string[] = []
    const request = vi
      .fn()
      .mockImplementation((path: string, options?: { method?: string }) => {
        const method = options?.method ?? "GET"
        if (method === "GET" && /\/repos\/[^/]+\/classroom50$/.test(path)) {
          return Promise.resolve({ name: "classroom50" })
        }
        if (
          method === "GET" &&
          path.includes("/orgs/") &&
          path.includes("/repos")
        ) {
          return Promise.resolve(
            ["classroom50", "cs101-hw1-alice"].map((name) => ({ name })),
          )
        }
        if (method === "DELETE") {
          const repo = path.split("/").pop() ?? ""
          if (repo === "cs101-hw1-alice" && aliceAttempts === 0) {
            aliceAttempts++
            return Promise.reject(serverError())
          }
          deletes.push(repo)
          return Promise.resolve(undefined)
        }
        return Promise.reject(new Error(`unexpected: ${method} ${path}`))
      })
    const requestRaw = emptyClassroomRequestRaw()
    const client: GitHubClient = {
      request: request as unknown as GitHubClient["request"],
      requestRaw: requestRaw as unknown as GitHubClient["requestRaw"],
    }
    const plan = await planTeardown(client, "acme")
    const result = await executeTeardown(client, plan)
    expect(result.failed).toHaveLength(0)
    expect(result.deleted).toEqual(
      expect.arrayContaining(["cs101-hw1-alice", "classroom50"]),
    )
    // Marker still deleted last after the retry recovery.
    expect(deletes[deletes.length - 1]).toBe("classroom50")
  })

  it("deletes only the teams classrooms link to in classroom.json", async () => {
    const { client, teamDeletes } = makeClient({
      markerExists: true,
      repos: ["classroom50", "cs101-hw1-alice"],
      classrooms: [
        { dir: "cs101", team: { id: 11, slug: "classroom50-cs101" } },
        { dir: "math200", team: { id: 22, slug: "classroom50-math200" } },
        { dir: "legacy" },
      ],
    })
    const plan = await planTeardown(client, "acme")
    const result = await executeTeardown(client, plan)
    expect(result.teamsDeleted.sort()).toEqual([
      "classroom50-cs101",
      "classroom50-math200",
    ])
    expect(result.teamsFailed).toHaveLength(0)
    expect(teamDeletes.sort()).toEqual([
      "classroom50-cs101",
      "classroom50-math200",
    ])
  })

  it("does not touch teams that no classroom links to", async () => {
    // Even though a classroom50-stray team could exist in the org, teardown
    // only deletes teams resolved from classroom.json.
    const { client, teamDeletes } = makeClient({
      markerExists: true,
      repos: ["classroom50"],
      classrooms: [
        { dir: "cs101", team: { id: 11, slug: "classroom50-cs101" } },
      ],
    })
    const plan = await planTeardown(client, "acme")
    const result = await executeTeardown(client, plan)
    expect(result.teamsDeleted).toEqual(["classroom50-cs101"])
    expect(teamDeletes).toEqual(["classroom50-cs101"])
  })

  it("treats an already-gone team (404) as deleted", async () => {
    const { client } = makeClient({
      markerExists: true,
      repos: ["classroom50"],
      classrooms: [
        { dir: "cs101", team: { id: 11, slug: "classroom50-cs101" } },
      ],
      failTeams: { "classroom50-cs101": "not-found" },
    })
    const plan = await planTeardown(client, "acme")
    const result = await executeTeardown(client, plan)
    expect(result.teamsDeleted).toEqual(["classroom50-cs101"])
    expect(result.teamsFailed).toHaveLength(0)
  })

  it("retains the marker when a team delete fails transiently (5xx), so a re-run can finish it", async () => {
    // A transient 5xx team failure is recoverable: the marker repo (which holds
    // classroom.json, the team-ref source) is preserved so a re-run can
    // re-resolve and finish the team, rather than orphaning it.
    const { client, deletes } = makeClient({
      markerExists: true,
      repos: ["classroom50", "cs101-hw1-alice"],
      classrooms: [
        { dir: "cs101", team: { id: 11, slug: "classroom50-cs101" } },
      ],
      failTeams: { "classroom50-cs101": "server" },
    })
    const plan = await planTeardown(client, "acme")
    const result = await executeTeardown(client, plan)
    expect(result.teamsFailed).toEqual(["classroom50-cs101"])
    expect(result.teamsDeleted).toHaveLength(0)
    expect(result.failed).toHaveLength(0)
    // Non-marker repos deleted, but the marker is retained (recoverable).
    expect(deletes).toContain("cs101-hw1-alice")
    expect(deletes).not.toContain("classroom50")
    expect(result.markerDeleted).toBe(false)
  })

  it("retains the marker when a team delete is throttled (recoverable, re-runnable)", async () => {
    // A rate-limited team delete is recoverable, like a transient 5xx: the
    // marker is preserved so a re-run can re-resolve and finish the throttled
    // team. Without this the team would be silently orphaned once the marker —
    // its only ref source — was gone.
    const { client, deletes } = makeClient({
      markerExists: true,
      repos: ["classroom50", "cs101-hw1-alice"],
      classrooms: [
        { dir: "cs101", team: { id: 11, slug: "classroom50-cs101" } },
      ],
      failTeams: { "classroom50-cs101": "rate-limit" },
    })
    const plan = await planTeardown(client, "acme")
    const result = await executeTeardown(client, plan)
    expect(result.teamsFailed).toEqual(["classroom50-cs101"])
    expect(result.teamsDeleted).toHaveLength(0)
    expect(result.failed).toHaveLength(0)
    expect(deletes).toContain("cs101-hw1-alice")
    expect(deletes).not.toContain("classroom50")
    expect(result.markerDeleted).toBe(false)
  })

  it("ignores a team ref outside the classroom50- namespace or without a positive id", async () => {
    // classroom.json is untrusted (config-repo-write authored, parsed without
    // schema validation). A team ref naming a non-classroom50 slug, or one
    // missing a positive id (which would skip deleteClassroomTeam's id-match
    // guard and delete the slug blind), must never enter the delete set.
    const { client, teamDeletes } = makeClient({
      markerExists: true,
      repos: ["classroom50"],
      classrooms: [
        { dir: "evil", team: { id: 0, slug: "admins" } },
        { dir: "evil2", team: { id: 5, slug: "owners" } },
        { dir: "cs101", team: { id: 11, slug: "classroom50-cs101" } },
      ],
    })
    const plan = await planTeardown(client, "acme")
    expect(plan.teams.map((t) => t.slug)).toEqual(["classroom50-cs101"])
    const result = await executeTeardown(client, plan)
    expect(result.teamsDeleted).toEqual(["classroom50-cs101"])
    expect(teamDeletes).toEqual(["classroom50-cs101"])
  })

  it("refuses to delete a team whose live id no longer matches (reused slug)", async () => {
    // The slug now points at a different team (different id) than the one this
    // classroom recorded — deleteClassroomTeam refuses with TeamIdMismatchError,
    // it lands in teamsFailed without clobbering the unrelated team, and because
    // the refusal is PERMANENT (a re-run repeats it) the marker is still deleted
    // so teardown isn't wedged forever.
    const { client, teamDeletes, deletes } = makeClient({
      markerExists: true,
      repos: ["classroom50"],
      classrooms: [
        { dir: "cs101", team: { id: 11, slug: "classroom50-cs101" } },
      ],
      teamIdMismatch: { "classroom50-cs101": 999 },
    })
    const plan = await planTeardown(client, "acme")
    const result = await executeTeardown(client, plan)
    expect(result.teamsFailed).toEqual(["classroom50-cs101"])
    expect(result.teamsDeleted).toHaveLength(0)
    expect(teamDeletes).not.toContain("classroom50-cs101")
    // Permanent refusal does not retain the marker.
    expect(deletes).toContain("classroom50")
    expect(result.markerDeleted).toBe(true)
  })

  it("does not delete teams when a repo scope wall aborts the run", async () => {
    const { client, teamDeletes } = makeClient({
      markerExists: true,
      repos: ["classroom50", "cs101-hw1-alice"],
      classrooms: [
        { dir: "cs101", team: { id: 11, slug: "classroom50-cs101" } },
      ],
      deleteForbidden: true,
    })
    const plan = await planTeardown(client, "acme")
    await expect(executeTeardown(client, plan)).rejects.toBeInstanceOf(
      TeardownScopeError,
    )
    // The run aborts before team deletion runs.
    expect(teamDeletes).toHaveLength(0)
  })
})

describe("formatTeardownResult", () => {
  const base: TeardownResult = {
    deleted: [],
    failed: [],
    teamsDeleted: [],
    teamsFailed: [],
    markerDeleted: true,
  }
  const url = "https://github.com/orgs/acme/teams"

  it("reports a clean run with repos and teams", () => {
    expect(
      formatTeardownResult(
        {
          ...base,
          deleted: ["a", "b", "classroom50"],
          teamsDeleted: ["classroom50-cs101"],
        },
        url,
      ),
    ).toBe("Deleted 3 repositories and 1 classroom team.")
  })

  it("uses singular nouns for a one-repo, no-team run", () => {
    expect(
      formatTeardownResult({ ...base, deleted: ["classroom50"] }, url),
    ).toBe("Deleted 1 repository.")
  })

  it("tells the user to re-run when a repo failed (marker retained)", () => {
    expect(
      formatTeardownResult(
        { ...base, deleted: ["a"], failed: ["b"], markerDeleted: false },
        url,
      ),
    ).toBe(
      "Deleted 1 repository; 1 repository could not be deleted. Re-run teardown to finish.",
    )
  })

  it("tells the user to remove teams by hand when only teams failed and the marker is gone", () => {
    expect(
      formatTeardownResult(
        {
          ...base,
          deleted: ["a", "classroom50"],
          teamsFailed: ["classroom50-cs101", "classroom50-math200"],
          markerDeleted: true,
        },
        url,
      ),
    ).toBe(
      `Deleted 2 repositories; 2 teams could not be deleted. Remove the leftover teams by hand at ${url}.`,
    )
  })

  it("re-runs (not by-hand) when teams failed but were recoverable so the marker was retained", () => {
    expect(
      formatTeardownResult(
        {
          ...base,
          deleted: ["a"],
          teamsFailed: ["classroom50-cs101"],
          markerDeleted: false,
        },
        url,
      ),
    ).toBe(
      "Deleted 1 repository; 1 team could not be deleted. Re-run teardown to finish.",
    )
  })

  it("joins failed repos and teams with 'and'", () => {
    expect(
      formatTeardownResult(
        {
          ...base,
          deleted: ["a"],
          failed: ["b"],
          teamsFailed: ["classroom50-cs101"],
          markerDeleted: false,
        },
        url,
      ),
    ).toBe(
      "Deleted 1 repository; 1 repository and 1 team could not be deleted. Re-run teardown to finish.",
    )
  })
})
