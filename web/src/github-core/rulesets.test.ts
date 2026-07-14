import { describe, expect, it, vi } from "vitest"

import {
  RULESET_NAME_FEEDBACK_BASE,
  RULESET_NAME_SUBMISSION_HISTORY,
  checkRulesets,
  classroomRulesetBodies,
  repairRulesets,
} from "./rulesets"
import type { GitHubClient } from "./client"

// The two org rulesets mirror the CLI: submission-history (default branch,
// non_fast_forward + deletion) and feedback-base-lock (refs/heads/feedback,
// update + deletion), both with an OrganizationAdmin always-bypass. Reconcile
// is create-or-PUT-by-name. The fake client records POST/PUT calls.

type Recorded = { method: string; path: string; body: unknown }

function makeClient(existing: Array<{ id: number; name: string }>) {
  const calls: Recorded[] = []
  const request = vi
    .fn()
    .mockImplementation(
      (path: string, options?: { method?: string; body?: unknown }) => {
        const method = options?.method ?? "GET"
        calls.push({ method, path, body: options?.body })
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
  }
  return { client, calls }
}

describe("classroomRulesetBodies", () => {
  it("defines the two rulesets exactly as the CLI does", () => {
    const [submission, feedback] = classroomRulesetBodies()

    expect(submission.name).toBe(RULESET_NAME_SUBMISSION_HISTORY)
    expect(submission.conditions.ref_name.include).toEqual(["~DEFAULT_BRANCH"])
    expect(submission.rules.map((r) => r.type)).toEqual([
      "non_fast_forward",
      "deletion",
    ])

    expect(feedback.name).toBe(RULESET_NAME_FEEDBACK_BASE)
    expect(feedback.conditions.ref_name.include).toEqual([
      "refs/heads/feedback",
    ])
    expect(feedback.rules.map((r) => r.type)).toEqual(["update", "deletion"])

    for (const rs of [submission, feedback]) {
      expect(rs.target).toBe("branch")
      expect(rs.enforcement).toBe("active")
      expect(rs.conditions.repository_name.include).toEqual(["~ALL"])
      expect(rs.bypass_actors).toEqual([
        { actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" },
      ])
    }
  })
})

describe("repairRulesets", () => {
  it("POSTs both rulesets when neither exists", async () => {
    const { client, calls } = makeClient([])
    const result = await repairRulesets(client, "acme")
    const posts = calls.filter((c) => c.method === "POST")
    expect(posts).toHaveLength(2)
    expect(calls.some((c) => c.method === "PUT")).toBe(false)
    expect(result.status).toBe("complete")
    expect(result.created).toHaveLength(2)
  })

  it("PUTs over existing rulesets (reconcile by name), no POSTs", async () => {
    const { client, calls } = makeClient([
      { id: 10, name: RULESET_NAME_SUBMISSION_HISTORY },
      { id: 20, name: RULESET_NAME_FEEDBACK_BASE },
    ])
    const result = await repairRulesets(client, "acme")
    const puts = calls.filter((c) => c.method === "PUT")
    expect(puts).toHaveLength(2)
    expect(puts.map((c) => c.path)).toContain("/orgs/acme/rulesets/10")
    expect(puts.map((c) => c.path)).toContain("/orgs/acme/rulesets/20")
    expect(calls.some((c) => c.method === "POST")).toBe(false)
    expect(result.updated).toHaveLength(2)
  })

  it("creates the missing one and updates the existing one", async () => {
    const { client, calls } = makeClient([
      { id: 10, name: RULESET_NAME_SUBMISSION_HISTORY },
    ])
    const result = await repairRulesets(client, "acme")
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
    }
    const result = await repairRulesets(client, "acme")
    expect(result.status).toBe("warning")
    expect(result.failed).toHaveLength(1)
    expect(result.created).toHaveLength(1)
  })
})

describe("checkRulesets", () => {
  it("enforced when both rulesets exist", async () => {
    const { client } = makeClient([
      { id: 10, name: RULESET_NAME_SUBMISSION_HISTORY },
      { id: 20, name: RULESET_NAME_FEEDBACK_BASE },
    ])
    expect((await checkRulesets(client, "acme")).state).toBe("enforced")
  })

  it("unenforced when a ruleset is missing", async () => {
    const { client } = makeClient([
      { id: 10, name: RULESET_NAME_SUBMISSION_HISTORY },
    ])
    const verdict = await checkRulesets(client, "acme")
    expect(verdict.state).toBe("unenforced")
    expect(verdict.detail).toContain(RULESET_NAME_FEEDBACK_BASE)
  })
})
