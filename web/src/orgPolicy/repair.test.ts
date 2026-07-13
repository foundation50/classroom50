import { describe, expect, it, vi } from "vitest"

import { REPAIRABLE_CONCERNS, repairConcern } from "./repair"
import type { ConcernId } from "./audit"
import { memberDefaultSettings } from "./desiredState"
import {
  RULESET_NAME_FEEDBACK_BASE,
  RULESET_NAME_SUBMISSION_HISTORY,
} from "@/hooks/github/rulesets"
import { GitHubAPIError } from "@/hooks/github/errors"
import type { GitHubClient } from "@/hooks/github/client"

// repairConcern dispatches each audit concern to the mutation that restores its
// setting. The fake client records write paths/methods so each case can assert
// it hit the right GitHub endpoint.

type Recorded = { method: string; path: string }

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

function makeClient(configRepoBranch = "main"): {
  client: GitHubClient
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const request = vi
    .fn()
    .mockImplementation((path: string, options?: { method?: string }) => {
      const method = options?.method ?? "GET"
      calls.push({ method, path })
      // Reads the dispatcher's repairs perform: org read-back, rulesets list.
      if (method === "GET" && path === "/orgs/acme") {
        const live: Record<string, unknown> = {}
        for (const s of memberDefaultSettings("team")) live[s.field] = s.value
        return Promise.resolve(live)
      }
      // ensureBranchProtection resolves the config repo's real default branch.
      if (method === "GET" && path === "/repos/acme/classroom50") {
        return Promise.resolve({ default_branch: configRepoBranch })
      }
      if (method === "GET" && path.includes("/rulesets")) {
        return Promise.resolve([
          { id: 1, name: RULESET_NAME_SUBMISSION_HISTORY },
          { id: 2, name: RULESET_NAME_FEEDBACK_BASE },
        ])
      }
      if (method === "GET" && path.includes("/actions/permissions/workflow")) {
        return Promise.resolve({
          default_workflow_permissions: "write",
          can_approve_pull_request_reviews: false,
        })
      }
      return Promise.resolve({})
    })
  return {
    client: {
      request: request as unknown as GitHubClient["request"],
      requestRaw: () => Promise.reject(new Error("unexpected requestRaw")),
    },
    calls,
  }
}

const writePaths = (calls: Recorded[]) =>
  calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)

describe("repairConcern", () => {
  it("orgActions enables org Actions permissions", async () => {
    const { client, calls } = makeClient()
    await repairConcern(client, "acme", "orgActions", "team")
    expect(writePaths(calls)).toContain("PUT /orgs/acme/actions/permissions")
  })

  it("orgPrCreation enables Actions PR creation", async () => {
    const { client, calls } = makeClient()
    await repairConcern(client, "acme", "orgPrCreation", "team")
    expect(writePaths(calls)).toContain(
      "PUT /orgs/acme/actions/permissions/workflow",
    )
  })

  it("branchProtection writes the config repo's branch protection", async () => {
    const { client, calls } = makeClient()
    await repairConcern(client, "acme", "branchProtection", "team")
    expect(writePaths(calls)).toContain(
      "PUT /repos/acme/classroom50/branches/main/protection",
    )
  })

  it("branchProtection targets the config repo's real default branch (master)", async () => {
    const { client, calls } = makeClient("master")
    await repairConcern(client, "acme", "branchProtection", "team")
    expect(writePaths(calls)).toContain(
      "PUT /repos/acme/classroom50/branches/master/protection",
    )
    expect(writePaths(calls)).not.toContain(
      "PUT /repos/acme/classroom50/branches/main/protection",
    )
  })

  it("branchProtection success returns no unresolved outcome", async () => {
    const { client } = makeClient()
    const result = await repairConcern(
      client,
      "acme",
      "branchProtection",
      "team",
    )
    expect(result.unresolved).toBeUndefined()
  })

  it("branchProtection reports unresolved (non-transient) on a 403", async () => {
    // A forbidden PUT surfaces as a warning from ensureBranchProtection; the
    // dispatcher reports it as unresolved without asserting the cause.
    const request = vi
      .fn()
      .mockImplementation((path: string, options?: { method?: string }) => {
        const method = options?.method ?? "GET"
        if (method === "PUT" && path.includes("/protection")) {
          return Promise.reject(httpError(403))
        }
        return Promise.resolve({})
      })
    const client: GitHubClient = {
      request: request as unknown as GitHubClient["request"],
      requestRaw: () => Promise.reject(new Error("x")),
    }
    const result = await repairConcern(
      client,
      "acme",
      "branchProtection",
      "team",
    )
    expect(result.unresolved).toBeDefined()
    expect(result.unresolved?.transient).toBe(false)
    expect(result.unresolved?.message).toBeTruthy()
  })

  it("branchProtection reports unresolved (transient) when the branch is missing", async () => {
    // A 404 maps to reason "branch_not_found" — the repo may still be
    // initializing, so it's transient and should stay retryable.
    const request = vi
      .fn()
      .mockImplementation((path: string, options?: { method?: string }) => {
        const method = options?.method ?? "GET"
        if (method === "PUT" && path.includes("/protection")) {
          return Promise.reject(httpError(404))
        }
        return Promise.resolve({})
      })
    const client: GitHubClient = {
      request: request as unknown as GitHubClient["request"],
      requestRaw: () => Promise.reject(new Error("x")),
    }
    const result = await repairConcern(
      client,
      "acme",
      "branchProtection",
      "team",
    )
    expect(result.unresolved).toBeDefined()
    expect(result.unresolved?.transient).toBe(true)
  })

  it("reusableWorkflowAccess sets the access level", async () => {
    const { client, calls } = makeClient()
    await repairConcern(client, "acme", "reusableWorkflowAccess", "team")
    expect(writePaths(calls)).toContain(
      "PUT /repos/acme/classroom50/actions/permissions/access",
    )
  })

  it("pages enables Pages on the config repo", async () => {
    const { client, calls } = makeClient()
    await repairConcern(client, "acme", "pages", "team")
    expect(
      writePaths(calls).some((p) =>
        p.includes("/repos/acme/classroom50/pages"),
      ),
    ).toBe(true)
  })

  it("orgDefaults PATCHes the org member defaults", async () => {
    const { client, calls } = makeClient()
    await repairConcern(client, "acme", "orgDefaults", "team")
    expect(writePaths(calls)).toContain("PATCH /orgs/acme")
  })

  it("rulesets reconciles both org rulesets", async () => {
    const { client, calls } = makeClient()
    await repairConcern(client, "acme", "rulesets", "team")
    // Both rulesets already exist in the fake, so they're PUT-reconciled.
    expect(
      writePaths(calls).filter((p) => p.startsWith("PUT /orgs/acme/rulesets/")),
    ).toHaveLength(2)
  })

  it("rulesets success returns no unresolved outcome", async () => {
    const { client } = makeClient()
    const result = await repairConcern(client, "acme", "rulesets", "team")
    expect(result.unresolved).toBeUndefined()
  })

  it("rulesets reports unresolved (non-transient) when a ruleset write fails", async () => {
    // Neither ruleset exists, and both POSTs fail — repairRulesets returns a
    // warning with a non-empty failed[], surfaced as a cause-neutral unresolved.
    const request = vi
      .fn()
      .mockImplementation((path: string, options?: { method?: string }) => {
        const method = options?.method ?? "GET"
        if (method === "GET" && path.includes("/rulesets")) {
          return Promise.resolve([])
        }
        if (method === "POST" && path.endsWith("/rulesets")) {
          return Promise.reject(httpError(422))
        }
        return Promise.resolve({})
      })
    const client: GitHubClient = {
      request: request as unknown as GitHubClient["request"],
      requestRaw: () => Promise.reject(new Error("x")),
    }
    const result = await repairConcern(client, "acme", "rulesets", "team")
    expect(result.unresolved).toBeDefined()
    expect(result.unresolved?.transient).toBe(false)
    expect(result.unresolved?.message).toBeTruthy()
  })

  it("every audit concern is repairable", () => {
    const ids: ConcernId[] = [
      "orgDefaults",
      "orgActions",
      "orgPrCreation",
      "branchProtection",
      "workflowPermissions",
      "reusableWorkflowAccess",
      "pages",
      "rulesets",
    ]
    for (const id of ids) expect(REPAIRABLE_CONCERNS.has(id)).toBe(true)
  })
})
