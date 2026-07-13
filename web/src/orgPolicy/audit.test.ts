import { describe, expect, it } from "vitest"

import { buildOrgAuditReport } from "./audit"
import type { ConcernId } from "./audit"
import { memberDefaultSettings } from "./desiredState"
import { GitHubAPIError } from "@/hooks/github/errors"
import {
  RULESET_NAME_FEEDBACK_BASE,
  RULESET_NAME_SUBMISSION_HISTORY,
} from "@/hooks/github/rulesets"
import type { GitHubClient } from "@/hooks/github/client"

// The audit assembles checkOrgDefaults + the per-concern checks into a verdict.
// The GUI is stricter than the CLI: ANY drift (critical or not) fails; a read
// failure fails; all enforced is ok. The 4 manual items never fail.

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

type Routes = {
  orgDefaults?: Record<string, unknown> | GitHubAPIError
  // The classroom50 config repo's default branch (or an error to simulate an
  // unreadable/uninitialized repo). Defaults to "main" (no recommendation).
  configRepoBranch?: string | GitHubAPIError
}

// A fully-enforced fake org: every check returns its desired value, both
// rulesets present. Overrides let a test drift one concern.
function makeClient(overrides: Routes = {}): GitHubClient {
  const enforcedDefaults: Record<string, unknown> = {}
  for (const s of memberDefaultSettings("team")) {
    enforcedDefaults[s.field] = s.value
  }

  return {
    request: <T>(path: string) => {
      const reject = (e: GitHubAPIError) => Promise.reject(e) as Promise<T>
      const ok = (v: unknown) => Promise.resolve(v as T)

      if (path === "/orgs/acme") {
        if (overrides.orgDefaults instanceof GitHubAPIError)
          return reject(overrides.orgDefaults)
        return ok(overrides.orgDefaults ?? enforcedDefaults)
      }
      if (path === "/repos/acme/classroom50") {
        if (overrides.configRepoBranch instanceof GitHubAPIError)
          return reject(overrides.configRepoBranch)
        return ok({ default_branch: overrides.configRepoBranch ?? "main" })
      }
      if (path.endsWith("/actions/permissions"))
        return ok({ enabled_repositories: "all", allowed_actions: "all" })
      if (path.endsWith("/actions/permissions/workflow"))
        return ok({
          default_workflow_permissions: "write",
          can_approve_pull_request_reviews: true,
        })
      if (path.includes("/protection"))
        return ok({
          allow_force_pushes: { enabled: false },
          allow_deletions: { enabled: false },
        })
      if (path.includes("/permissions/access"))
        return ok({ access_level: "organization" })
      if (path.includes("/pages"))
        return ok({ build_type: "workflow", public: true })
      if (path.includes("/rulesets"))
        return ok([
          { id: 1, name: RULESET_NAME_SUBMISSION_HISTORY },
          { id: 2, name: RULESET_NAME_FEEDBACK_BASE },
        ])
      return Promise.reject(new Error(`unexpected: ${path}`)) as Promise<T>
    },
    requestRaw: () => Promise.reject(new Error("unexpected requestRaw")),
  }
}

function driftedDefaults(
  mutate: (live: Record<string, unknown>) => void,
): Record<string, unknown> {
  const live: Record<string, unknown> = {}
  for (const s of memberDefaultSettings("team")) live[s.field] = s.value
  mutate(live)
  return live
}

describe("buildOrgAuditReport", () => {
  it("verdict ok when everything is enforced", async () => {
    const report = await buildOrgAuditReport(makeClient(), "acme", "team")
    expect(report.verdict).toBe("ok")
    expect(report.readOk).toBe(true)
    expect(report.lockdownComplete).toBe(true)
    expect(report.unenforcedDefaults).toHaveLength(0)
    expect(report.manualUnreadable).toHaveLength(4)
    // The full member-default list is surfaced so teachers see every permission
    // we set, all enforced here (11 on a team plan).
    expect(report.defaultVerdicts).toHaveLength(11)
    expect(report.defaultVerdicts.every((v) => v.enforced)).toBe(true)
  })

  it("recommends switching a non-main org default branch without failing", async () => {
    const report = await buildOrgAuditReport(
      makeClient({
        orgDefaults: driftedDefaults((live) => {
          live.default_repository_branch = "master"
        }),
      }),
      "acme",
      "team",
    )
    // Advisory only — a non-main default branch never fails the verdict.
    expect(report.verdict).toBe("ok")
    expect(report.recommendations).toHaveLength(1)
    expect(report.recommendations[0].id).toBe("orgDefaultBranch")
    expect(report.recommendations[0].detail).toBe("master")
    expect(report.recommendations[0].settingsUrl).toContain(
      "/settings/repository-defaults",
    )
  })

  it("no recommendation when the org default branch is already main", async () => {
    const report = await buildOrgAuditReport(
      makeClient({
        orgDefaults: driftedDefaults((live) => {
          live.default_repository_branch = "main"
        }),
      }),
      "acme",
      "team",
    )
    expect(report.recommendations).toHaveLength(0)
  })

  it("recommends renaming a non-main config repo branch without failing", async () => {
    const report = await buildOrgAuditReport(
      makeClient({ configRepoBranch: "master" }),
      "acme",
      "team",
    )
    // Advisory only — a drifted config-repo branch never fails the verdict.
    expect(report.verdict).toBe("ok")
    const rec = report.recommendations.find(
      (r) => r.id === "configRepoDefaultBranch",
    )
    expect(rec).toBeDefined()
    expect(rec?.detail).toBe("master")
    expect(rec?.settingsUrl).toBe(
      "https://github.com/acme/classroom50/settings/branches",
    )
  })

  it("no config-repo recommendation when it is already main or unreadable", async () => {
    const onMain = await buildOrgAuditReport(
      makeClient({ configRepoBranch: "main" }),
      "acme",
      "team",
    )
    expect(
      onMain.recommendations.some((r) => r.id === "configRepoDefaultBranch"),
    ).toBe(false)

    // A read failure (e.g. repo not initialized) suppresses the advisory rec.
    const unreadable = await buildOrgAuditReport(
      makeClient({ configRepoBranch: httpError(404) }),
      "acme",
      "team",
    )
    expect(unreadable.verdict).toBe("ok")
    expect(
      unreadable.recommendations.some(
        (r) => r.id === "configRepoDefaultBranch",
      ),
    ).toBe(false)
  })

  it("lists the config-repo rename recommendation first (it's the actionable one)", async () => {
    const report = await buildOrgAuditReport(
      makeClient({
        configRepoBranch: "master",
        orgDefaults: driftedDefaults((live) => {
          live.default_repository_branch = "master"
        }),
      }),
      "acme",
      "team",
    )
    expect(report.recommendations.map((r) => r.id)).toEqual([
      "configRepoDefaultBranch",
      "orgDefaultBranch",
    ])
  })

  it("verdict fail when a critical member-default drifts", async () => {
    const report = await buildOrgAuditReport(
      makeClient({
        orgDefaults: driftedDefaults((live) => {
          live.members_can_delete_repositories = true
        }),
      }),
      "acme",
      "team",
    )
    expect(report.verdict).toBe("fail")
    expect(report.lockdownComplete).toBe(false)
    expect(report.unenforcedDefaults.map((s) => s.field)).toContain(
      "members_can_delete_repositories",
    )
  })

  it("verdict fail when a non-critical default drifts (GUI treats all drift as actionable)", async () => {
    const report = await buildOrgAuditReport(
      makeClient({
        orgDefaults: driftedDefaults((live) => {
          live.members_can_create_pages = false
        }),
      }),
      "acme",
      "team",
    )
    expect(report.verdict).toBe("fail")
    // lockdownComplete is critical-only (CLI parity): non-critical drift keeps
    // it true, but the verdict still fails since any drift is actionable.
    expect(report.lockdownComplete).toBe(true)
    expect(report.unenforcedDefaults.map((s) => s.field)).toContain(
      "members_can_create_pages",
    )
  })

  it("verdict fail when a per-concern check drifts", async () => {
    const report = await buildOrgAuditReport(
      // Pages drifts via a 404 → unenforced, with member defaults all enforced.
      {
        request: <T>(path: string) => {
          const ok = (v: unknown) => Promise.resolve(v as T)
          if (path === "/orgs/acme") {
            const live: Record<string, unknown> = {}
            for (const s of memberDefaultSettings("team"))
              live[s.field] = s.value
            return ok(live)
          }
          if (path.endsWith("/actions/permissions"))
            return ok({ enabled_repositories: "all", allowed_actions: "all" })
          if (path.endsWith("/actions/permissions/workflow"))
            return ok({
              default_workflow_permissions: "write",
              can_approve_pull_request_reviews: true,
            })
          if (path.includes("/protection"))
            return ok({
              allow_force_pushes: { enabled: false },
              allow_deletions: { enabled: false },
            })
          if (path.includes("/permissions/access"))
            return ok({ access_level: "organization" })
          if (path.includes("/pages"))
            return Promise.reject(httpError(404)) as Promise<T>
          if (path.includes("/rulesets"))
            return ok([
              { id: 1, name: RULESET_NAME_SUBMISSION_HISTORY },
              { id: 2, name: RULESET_NAME_FEEDBACK_BASE },
            ])
          return Promise.reject(new Error(`unexpected: ${path}`)) as Promise<T>
        },
        requestRaw: () => Promise.reject(new Error("unexpected requestRaw")),
      },
      "acme",
      "team",
    )
    expect(report.verdict).toBe("fail")
    expect(report.lockdownComplete).toBe(true)
  })

  it("verdict fail when a per-concern check is unreadable (partial outage is not a clean bill of health)", async () => {
    const report = await buildOrgAuditReport(
      {
        request: <T>(path: string) => {
          const ok = (v: unknown) => Promise.resolve(v as T)
          if (path === "/orgs/acme") {
            const live: Record<string, unknown> = {}
            for (const s of memberDefaultSettings("team"))
              live[s.field] = s.value
            return ok(live)
          }
          if (path.endsWith("/actions/permissions"))
            return ok({ enabled_repositories: "all", allowed_actions: "all" })
          if (path.endsWith("/actions/permissions/workflow"))
            return ok({
              default_workflow_permissions: "write",
              can_approve_pull_request_reviews: true,
            })
          if (path.includes("/protection"))
            return ok({
              allow_force_pushes: { enabled: false },
              allow_deletions: { enabled: false },
            })
          if (path.includes("/permissions/access"))
            return ok({ access_level: "organization" })
          // Pages read fails with a 500 → unreadable (not 404/unenforced).
          if (path.includes("/pages"))
            return Promise.reject(httpError(500)) as Promise<T>
          if (path.includes("/rulesets"))
            return ok([
              { id: 1, name: RULESET_NAME_SUBMISSION_HISTORY },
              { id: 2, name: RULESET_NAME_FEEDBACK_BASE },
            ])
          return Promise.reject(new Error(`unexpected: ${path}`)) as Promise<T>
        },
        requestRaw: () => Promise.reject(new Error("unexpected requestRaw")),
      },
      "acme",
      "team",
    )
    expect(report.verdict).toBe("fail")
    expect(report.lockdownComplete).toBe(true)
    expect(report.concerns.find((c) => c.id === "pages")?.verdict.state).toBe(
      "unreadable",
    )
  })

  it("verdict fail and readOk false when the org cannot be read", async () => {
    const report = await buildOrgAuditReport(
      makeClient({ orgDefaults: httpError(500) }),
      "acme",
      "team",
    )
    expect(report.verdict).toBe("fail")
    expect(report.readOk).toBe(false)
    expect(report.unenforcedDefaults).toHaveLength(0)
  })

  it("always lists the four manual steps regardless of verdict", async () => {
    const report = await buildOrgAuditReport(
      makeClient({ orgDefaults: httpError(500) }),
      "acme",
      "team",
    )
    expect(report.manualUnreadable).toHaveLength(4)
  })

  it("attaches a GitHub settings URL to each concern", async () => {
    const report = await buildOrgAuditReport(makeClient(), "acme", "team")
    const url = (id: string) =>
      report.concerns.find((c) => c.id === id)?.settingsUrl
    expect(url("orgDefaults")).toBe(
      "https://github.com/organizations/acme/settings/member_privileges",
    )
    expect(url("orgActions")).toBe(
      "https://github.com/organizations/acme/settings/actions",
    )
    expect(url("rulesets")).toBe(
      "https://github.com/organizations/acme/settings/rules",
    )
    expect(url("branchProtection")).toBe(
      "https://github.com/acme/classroom50/settings/branches",
    )
    expect(url("pages")).toBe(
      "https://github.com/acme/classroom50/settings/pages",
    )
    expect(url("reusableWorkflowAccess")).toBe(
      "https://github.com/acme/classroom50/settings/actions",
    )
  })

  it("sorts the concern list alphabetically by title", async () => {
    const report = await buildOrgAuditReport(makeClient(), "acme", "team")
    const titles = report.concerns.map((c) => c.title)
    const sorted = [...titles].sort((a, b) => a.localeCompare(b))
    expect(titles).toEqual(sorted)
  })

  it("emits a concern for every ConcernId (no concern silently dropped)", async () => {
    const report = await buildOrgAuditReport(makeClient(), "acme", "team")
    // Guards against a new ConcernId wired into titles/repair but forgotten in
    // buildOrgAuditReport's concerns array. Keep in sync with the ConcernId
    // union.
    const expected: ConcernId[] = [
      "orgDefaults",
      "orgActions",
      "orgPrCreation",
      "branchProtection",
      "workflowPermissions",
      "reusableWorkflowAccess",
      "pages",
      "rulesets",
    ]
    expect(new Set(report.concerns.map((c) => c.id))).toEqual(new Set(expected))
    expect(report.concerns).toHaveLength(expected.length)
  })
})
