import { describe, expect, it, vi } from "vitest"

import { repairOrgDefaults } from "./orgChecks"
import { GitHubAPIError } from "./errors"
import type { GitHubClient } from "./client"
import { memberDefaultSettings } from "@/orgPolicy/desiredState"

// repairOrgDefaults mirrors the CLI's applyOrgMemberDefaults: a combined PATCH,
// a per-field 403/422 fallback, a secondary-rate-limit abort, and an
// authoritative read-back via classifyDefaults. The fake client records the
// PATCH bodies and serves a configurable org read-back.

function rateLimited(): GitHubAPIError {
  return new GitHubAPIError({
    status: 403,
    url: "x",
    message: "secondary rate limit",
    body: null,
    rateLimit: {
      limit: 60,
      remaining: 0,
      used: 60,
      reset: null,
      resource: null,
      retryAfter: 60,
    },
  })
}

function httpError(status: number): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: "x",
    message: `status ${status}`,
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

type ClientOpts = {
  // What the combined PATCH should do: resolve, or reject with an error.
  combinedPatch?: () => Promise<unknown>
  // Per-field PATCH behavior keyed by field, defaulting to resolve.
  perField?: Record<string, () => Promise<unknown>>
  // The org read-back the GET returns.
  readback: Record<string, unknown>
}

function makeClient(opts: ClientOpts) {
  const patchBodies: Array<Record<string, unknown>> = []
  let patchCount = 0
  let combinedSeen = false

  const repoCreationFields = new Set([
    "members_can_create_repositories",
    "members_can_create_private_repositories",
    "members_can_create_public_repositories",
    "members_can_create_internal_repositories",
  ])

  const request = vi
    .fn()
    .mockImplementation(
      (
        path: string,
        options?: { method?: string; body?: Record<string, unknown> },
      ) => {
        if (
          path === "/orgs/acme" &&
          (!options || options.method === "GET" || !options.method)
        ) {
          return Promise.resolve(opts.readback)
        }
        if (path === "/orgs/acme" && options?.method === "PATCH") {
          patchCount += 1
          const body = options.body ?? {}
          patchBodies.push(body)
          const keys = Object.keys(body)
          // The first PATCH is the combined one; everything after is a
          // per-field fallback sub-PATCH (a single field, or the grouped
          // repo-creation booleans).
          if (!combinedSeen) {
            combinedSeen = true
            return opts.combinedPatch
              ? opts.combinedPatch()
              : Promise.resolve({})
          }
          // Grouped repo-creation sub-PATCH: succeed unless a specific repo-
          // creation field has a handler (use the first matching one).
          if (keys.every((k) => repoCreationFields.has(k))) {
            const handlerKey = keys.find((k) => opts.perField?.[k])
            return handlerKey
              ? opts.perField![handlerKey]()
              : Promise.resolve({})
          }
          const handler = opts.perField?.[keys[0]]
          return handler ? handler() : Promise.resolve({})
        }
        return Promise.reject(new Error(`unexpected: ${path}`))
      },
    )

  const client: GitHubClient = {
    request: request as unknown as GitHubClient["request"],
    requestRaw: () => Promise.reject(new Error("unexpected requestRaw")),
  }
  return { client, patchBodies, getPatchCount: () => patchCount }
}

function enforced(plan: string | undefined): Record<string, unknown> {
  const live: Record<string, unknown> = {}
  for (const s of memberDefaultSettings(plan)) live[s.field] = s.value
  return live
}

describe("repairOrgDefaults", () => {
  it("applies a single combined PATCH and reports complete when read-back is clean", async () => {
    const { client, patchBodies } = makeClient({ readback: enforced("team") })
    const result = await repairOrgDefaults(client, "acme", "team")
    expect(result.ok).toBe(true)
    expect(result.transient).toBe(false)
    expect(result.unenforced).toHaveLength(0)
    // One combined PATCH, no per-field.
    expect(patchBodies).toHaveLength(1)
    expect(Object.keys(patchBodies[0]).length).toBe(12)
  })

  it("sends only 12 fields on a team plan", async () => {
    const { client, patchBodies } = makeClient({ readback: enforced("team") })
    await repairOrgDefaults(client, "acme", "team")
    expect(Object.keys(patchBodies[0])).not.toContain(
      "members_can_create_public_repositories",
    )
  })

  it("falls back per-field on a 422 and classifies residual state", async () => {
    const live = enforced("team")
    // A critical field stays drifted after the fallback (silently rejected).
    live.members_can_delete_repositories = true
    const { client, getPatchCount } = makeClient({
      combinedPatch: () => Promise.reject(httpError(422)),
      perField: {
        members_can_delete_repositories: () => Promise.reject(httpError(422)),
      },
      readback: live,
    })
    const result = await repairOrgDefaults(client, "acme", "team")
    // 1 combined + per-field fallback: the 2 in-scope repo-creation fields are
    // grouped into 1 sub-PATCH, the other 10 go individually = 11; total 12.
    expect(getPatchCount()).toBe(12)
    expect(result.ok).toBe(false)
    expect(result.unenforced.map((s) => s.field)).toContain(
      "members_can_delete_repositories",
    )
  })

  it("groups the entangled repo-creation booleans in the per-field fallback", async () => {
    const { client, patchBodies } = makeClient({
      combinedPatch: () => Promise.reject(httpError(422)),
      readback: enforced("enterprise"),
    })
    await repairOrgDefaults(client, "acme", "enterprise")
    // Exactly one fallback sub-PATCH carries the repo-creation booleans, and it
    // carries ALL four together (never split — splitting makes GitHub reset the
    // omitted ones via the deprecated legacy field).
    const repoCreationPatches = patchBodies.filter((b) =>
      Object.keys(b).some(
        (k) =>
          k.startsWith("members_can_create_") && k.endsWith("_repositories"),
      ),
    )
    // The combined PATCH (rejected) is patchBodies[0]; find the grouped one.
    const grouped = patchBodies
      .slice(1)
      .find((b) => "members_can_create_repositories" in b)
    expect(grouped).toBeDefined()
    expect(Object.keys(grouped!).sort()).toEqual(
      [
        "members_can_create_internal_repositories",
        "members_can_create_private_repositories",
        "members_can_create_public_repositories",
        "members_can_create_repositories",
      ].sort(),
    )
    // No fallback sub-PATCH sends a repo-creation field on its own.
    const splitRepoCreation = patchBodies
      .slice(1)
      .some(
        (b) =>
          Object.keys(b).length === 1 &&
          Object.keys(b)[0].startsWith("members_can_create_") &&
          Object.keys(b)[0].endsWith("_repositories"),
      )
    expect(splitRepoCreation).toBe(false)
    expect(repoCreationPatches.length).toBeGreaterThan(0)
  })

  it("reports criticalMissed when read-back shows a silently-ignored field (200 PATCH)", async () => {
    const live = enforced("team")
    live.members_can_change_repo_visibility = true // silently not applied
    const { client } = makeClient({ readback: live })
    const result = await repairOrgDefaults(client, "acme", "team")
    expect(result.ok).toBe(false)
    expect(result.unenforced.map((s) => s.field)).toContain(
      "members_can_change_repo_visibility",
    )
  })

  it("flags non-critical-only drift so setup surfaces it too", async () => {
    const live = enforced("team")
    live.members_can_create_pages = false // non-critical, stays drifted
    const { client } = makeClient({ readback: live })
    const result = await repairOrgDefaults(client, "acme", "team")
    // `ok` stays the critical-only "lockdown complete" verdict (CLI parity)...
    expect(result.ok).toBe(true)
    expect(result.unenforced.map((s) => s.field)).toContain(
      "members_can_create_pages",
    )
    // ...but the message flags the drift so the setup board doesn't stay silent.
    expect(result.message).toContain("need manual attention")
  })

  it("aborts as transient on a secondary-rate-limit without falling back per-field", async () => {
    const { client, getPatchCount } = makeClient({
      combinedPatch: () => Promise.reject(rateLimited()),
      readback: enforced("team"),
    })
    const result = await repairOrgDefaults(client, "acme", "team")
    expect(result.transient).toBe(true)
    expect(result.ok).toBe(false)
    // Only the one combined PATCH was attempted (no per-field amplification).
    expect(getPatchCount()).toBe(1)
  })

  it("does not manufacture a checklist or false success when the read-back fails", async () => {
    const client: GitHubClient = {
      request: vi
        .fn()
        .mockImplementation((_path: string, options?: { method?: string }) => {
          if (options?.method === "PATCH") return Promise.resolve({})
          return Promise.reject(httpError(500)) // read-back fails
        }) as unknown as GitHubClient["request"],
      requestRaw: () => Promise.reject(new Error("x")),
    }
    const result = await repairOrgDefaults(client, "acme", "team")
    // A failed read-back must NOT be reported as a completed lockdown: it is
    // surfaced as transient (retry) with no fabricated drift checklist.
    expect(result.ok).toBe(false)
    expect(result.transient).toBe(true)
    expect(result.unenforced).toHaveLength(0)
  })

  it("still reaches the read-back when a per-field PATCH fails with a non-403/422 error", async () => {
    // A 5xx on one fallback field must not escape before the read-back, or the
    // caller gets a bare exception with no residual-state report.
    const live = enforced("team")
    live.members_can_delete_issues = true // stays drifted (the 500'd field)
    const { client } = makeClient({
      combinedPatch: () => Promise.reject(httpError(422)),
      perField: {
        members_can_delete_issues: () => Promise.reject(httpError(500)),
      },
      readback: live,
    })
    const result = await repairOrgDefaults(client, "acme", "team")
    // Resolved (not thrown), with read-back-derived residual state.
    expect(result.transient).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.unenforced.map((s) => s.field)).toContain(
      "members_can_delete_issues",
    )
  })

  it("marks only API-accepted-but-unstuck fields as enterprise-pinned, not API-rejected ones", async () => {
    const live = enforced("team")
    // One field the API REJECTED per-field (422) and one the API ACCEPTED
    // (no per-field handler -> resolves) yet that did not stick on read-back.
    live.members_can_delete_repositories = true // rejected (422) -> NOT pinned
    live.members_can_change_repo_visibility = true // accepted but ignored -> pinned
    const { client } = makeClient({
      combinedPatch: () => Promise.reject(httpError(422)),
      perField: {
        members_can_delete_repositories: () => Promise.reject(httpError(422)),
      },
      readback: live,
    })
    const result = await repairOrgDefaults(client, "acme", "team")
    const pinned = result.enterprisePinned.map((s) => s.field)
    expect(pinned).toContain("members_can_change_repo_visibility")
    expect(pinned).not.toContain("members_can_delete_repositories")
    // Both are still reported as unenforced for the full drift checklist.
    expect(result.unenforced.map((s) => s.field)).toEqual(
      expect.arrayContaining([
        "members_can_delete_repositories",
        "members_can_change_repo_visibility",
      ]),
    )
  })
})
