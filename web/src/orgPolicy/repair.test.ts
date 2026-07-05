import { describe, expect, it, vi } from "vitest"

import { REPAIRABLE_CONCERNS, repairConcern } from "./repair"
import type { ConcernId } from "./audit"
import { memberDefaultSettings } from "./desiredState"
import {
  RULESET_NAME_FEEDBACK_BASE,
  RULESET_NAME_SUBMISSION_HISTORY,
} from "@/hooks/github/rulesets"
import type { GitHubClient } from "@/hooks/github/client"

// repairConcern dispatches each audit concern to the mutation that restores its
// setting. The fake client records write paths/methods so each case can assert
// it hit the right GitHub endpoint.

type Recorded = { method: string; path: string }

function makeClient(): { client: GitHubClient; calls: Recorded[] } {
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
