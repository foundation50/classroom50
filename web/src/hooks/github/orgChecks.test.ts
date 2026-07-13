import { describe, expect, it } from "vitest"

import {
  checkBranchProtection,
  checkOrgActions,
  checkOrgDefaults,
  checkOrgPrCreation,
  checkPages,
  checkReusableWorkflowAccess,
  checkWorkflowPermissions,
} from "./orgChecks"
import { GitHubAPIError } from "./errors"
import type { GitHubClient } from "./client"
import { memberDefaultSettings } from "@/orgPolicy/desiredState"

// Standalone read-only checks: each returns a verdict (enforced / unenforced /
// unreadable) and never throws. A path-routing fake client serves the GET
// responses; assertions read the returned verdict.

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

function makeClient(routes: Record<string, unknown>): GitHubClient {
  return {
    request: <T>(path: string) => {
      for (const [fragment, value] of Object.entries(routes)) {
        if (path.includes(fragment)) {
          if (value instanceof Error) return Promise.reject(value)
          return Promise.resolve(value as T)
        }
      }
      return Promise.reject(new Error(`unexpected request: ${path}`))
    },
    requestRaw: () => Promise.reject(new Error("unexpected requestRaw")),
  }
}

function enforcedOrgDefaults(
  plan: string | undefined,
): Record<string, unknown> {
  const live: Record<string, unknown> = {}
  for (const s of memberDefaultSettings(plan)) live[s.field] = s.value
  return live
}

describe("checkOrgDefaults", () => {
  it("enforced when all in-scope fields match", async () => {
    const client = makeClient({ "/orgs/acme": enforcedOrgDefaults("team") })
    const { verdict, classification } = await checkOrgDefaults(
      client,
      "acme",
      "team",
    )
    expect(verdict.state).toBe("enforced")
    expect(classification?.criticalMissed).toBe(false)
  })

  it("unenforced when a critical field drifts", async () => {
    const live = enforcedOrgDefaults("team")
    live.members_can_delete_repositories = true
    const client = makeClient({ "/orgs/acme": live })
    const { verdict } = await checkOrgDefaults(client, "acme", "team")
    expect(verdict.state).toBe("unenforced")
  })

  it("unreadable on a 403", async () => {
    const client = makeClient({ "/orgs/acme": forbidden() })
    const { verdict } = await checkOrgDefaults(client, "acme", "team")
    expect(verdict.state).toBe("unreadable")
  })
})

describe("checkOrgActions", () => {
  it("enforced only when all repos + all actions", async () => {
    const enforced = makeClient({
      "/actions/permissions": {
        enabled_repositories: "all",
        allowed_actions: "all",
      },
    })
    expect((await checkOrgActions(enforced, "acme")).state).toBe("enforced")

    const drifted = makeClient({
      "/actions/permissions": {
        enabled_repositories: "selected",
        allowed_actions: "all",
      },
    })
    expect((await checkOrgActions(drifted, "acme")).state).toBe("unenforced")
  })
})

describe("checkOrgPrCreation", () => {
  it("enforced when Actions may approve PRs", async () => {
    const client = makeClient({
      "/actions/permissions/workflow": {
        default_workflow_permissions: "write",
        can_approve_pull_request_reviews: true,
      },
    })
    expect((await checkOrgPrCreation(client, "acme")).state).toBe("enforced")
  })

  it("unenforced when Actions may not approve PRs", async () => {
    const client = makeClient({
      "/actions/permissions/workflow": {
        default_workflow_permissions: "write",
        can_approve_pull_request_reviews: false,
      },
    })
    expect((await checkOrgPrCreation(client, "acme")).state).toBe("unenforced")
  })
})

describe("checkBranchProtection", () => {
  it("enforced when force-push and deletion both disabled", async () => {
    const client = makeClient({
      "/protection": {
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
      },
    })
    expect((await checkBranchProtection(client, "acme")).state).toBe("enforced")
  })

  it("unenforced when force-push is enabled", async () => {
    const client = makeClient({
      "/protection": {
        allow_force_pushes: { enabled: true },
        allow_deletions: { enabled: false },
      },
    })
    expect((await checkBranchProtection(client, "acme")).state).toBe(
      "unenforced",
    )
  })

  it("unenforced (not configured) on a 404", async () => {
    const client = makeClient({ "/protection": notFound() })
    expect((await checkBranchProtection(client, "acme")).state).toBe(
      "unenforced",
    )
  })

  it("resolves the config repo's real default branch (master), not main", async () => {
    const requested: string[] = []
    const client: GitHubClient = {
      request: <T>(path: string) => {
        requested.push(path)
        if (path === "/repos/acme/classroom50")
          return Promise.resolve({ default_branch: "master" } as T)
        if (path.includes("/branches/master/protection"))
          return Promise.resolve({
            allow_force_pushes: { enabled: false },
            allow_deletions: { enabled: false },
          } as T)
        return Promise.reject(new Error(`unexpected request: ${path}`))
      },
      requestRaw: () => Promise.reject(new Error("unexpected requestRaw")),
    }
    expect((await checkBranchProtection(client, "acme")).state).toBe("enforced")
    expect(
      requested.some((p) => p.includes("/branches/master/protection")),
    ).toBe(true)
    expect(requested.some((p) => p.includes("/branches/main/"))).toBe(false)
  })

  it("honors an explicit branch argument over the repo default", async () => {
    const requested: string[] = []
    const client: GitHubClient = {
      request: <T>(path: string) => {
        requested.push(path)
        if (path.includes("/branches/develop/protection"))
          return Promise.resolve({
            allow_force_pushes: { enabled: false },
            allow_deletions: { enabled: false },
          } as T)
        return Promise.reject(new Error(`unexpected request: ${path}`))
      },
      requestRaw: () => Promise.reject(new Error("unexpected requestRaw")),
    }
    expect(
      (await checkBranchProtection(client, "acme", "classroom50", "develop"))
        .state,
    ).toBe("enforced")
    // No repo read when the branch is given explicitly.
    expect(requested.some((p) => p === "/repos/acme/classroom50")).toBe(false)
  })
})

describe("checkReusableWorkflowAccess", () => {
  it("enforced at organization access level", async () => {
    const client = makeClient({
      "/permissions/access": { access_level: "organization" },
    })
    expect((await checkReusableWorkflowAccess(client, "acme")).state).toBe(
      "enforced",
    )
  })

  it("unenforced at none", async () => {
    const client = makeClient({
      "/permissions/access": { access_level: "none" },
    })
    expect((await checkReusableWorkflowAccess(client, "acme")).state).toBe(
      "unenforced",
    )
  })
})

describe("checkPages", () => {
  it("enforced when build_type workflow and public", async () => {
    const client = makeClient({
      "/pages": { build_type: "workflow", public: true },
    })
    expect((await checkPages(client, "acme")).state).toBe("enforced")
  })

  it("unenforced (not configured) on a 404", async () => {
    const client = makeClient({ "/pages": notFound() })
    expect((await checkPages(client, "acme")).state).toBe("unenforced")
  })
})

describe("checkWorkflowPermissions", () => {
  it("enforced when the repo default is write", async () => {
    const client = makeClient({
      "/repos/": { default_workflow_permissions: "write" },
      "/orgs/": { default_workflow_permissions: "read" },
    })
    expect((await checkWorkflowPermissions(client, "acme")).state).toBe(
      "enforced",
    )
  })

  it("enforced (org-managed) when repo is read but the org restricts write", async () => {
    const client = makeClient({
      "/repos/": { default_workflow_permissions: "read" },
      "/orgs/": { default_workflow_permissions: "read" },
    })
    const verdict = await checkWorkflowPermissions(client, "acme")
    expect(verdict.state).toBe("enforced")
    expect(verdict.detail).toMatch(/org policy/i)
  })

  it("unenforced when repo is read but the org allows write (fixable)", async () => {
    const client = makeClient({
      "/repos/": { default_workflow_permissions: "read" },
      "/orgs/": { default_workflow_permissions: "write" },
    })
    expect((await checkWorkflowPermissions(client, "acme")).state).toBe(
      "unenforced",
    )
  })
})
