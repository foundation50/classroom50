import { describe, expect, it } from "vitest"

import type { GitHubClient } from "./client"
import { GitHubAPIError } from "./errors"
import {
  ensureBranchProtection,
  ensureOrgActionsBudgetCap,
  ensureOrgActionsEnabled,
  ensureOrgCanCreatePullRequests,
  ensureReusableWorkflowAccess,
  setOrgActionsMode,
} from "./mutations"

// Every ensure* ladder's warning branch, one status at a time, snapshotted in
// full. The `reason` values are a contract (orgPolicy/repair keys on them and
// the setup board renders the messages), so a refactor of the ladders must
// reproduce each result byte for byte.

const org = "acme"
const rateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}
const apiError = (status: number, overrides?: Partial<typeof rateLimit>) =>
  new GitHubAPIError({
    status,
    url: "/x",
    message: `http ${status}`,
    body: {},
    rateLimit: { ...rateLimit, ...overrides },
  })
const plainError = new Error("boom")

// A fake client: GETs answer from `reads` (a value or an Error to throw),
// writes throw `writeError` when set.
function makeClient(opts: {
  reads?: Record<string, unknown>
  writeError?: unknown
}) {
  const request = async (
    path: string,
    init?: { method?: string; body?: unknown },
  ) => {
    const method = init?.method ?? "GET"
    if (method !== "GET") {
      if (opts.writeError) throw opts.writeError
      return {}
    }
    const key = Object.keys(opts.reads ?? {}).find((k) => path.startsWith(k))
    const value = key ? opts.reads![key] : undefined
    if (value instanceof Error) throw value
    if (value === undefined) throw new Error(`unexpected GET ${path}`)
    return value
  }
  return { request } as unknown as GitHubClient
}

const failures: [string, unknown][] = [
  ["403", apiError(403)],
  ["403 rate limited", apiError(403, { remaining: 0 })],
  ["404", apiError(404)],
  ["409", apiError(409)],
  ["422", apiError(422)],
  ["500", apiError(500)],
  ["non-API error", plainError],
]

describe("ensureReusableWorkflowAccess", () => {
  it("succeeds", async () => {
    expect(
      await ensureReusableWorkflowAccess(makeClient({}), org),
    ).toMatchSnapshot()
  })
  for (const [label, err] of failures) {
    it(`warns on ${label}`, async () => {
      expect(
        await ensureReusableWorkflowAccess(
          makeClient({ writeError: err }),
          org,
        ),
      ).toMatchSnapshot()
    })
  }
})

describe("ensureBranchProtection", () => {
  const reads = { [`/repos/${org}/classroom50`]: { default_branch: "main" } }
  it("succeeds", async () => {
    expect(
      await ensureBranchProtection(makeClient({ reads }), org),
    ).toMatchSnapshot()
  })
  for (const [label, err] of failures) {
    it(`warns on ${label}`, async () => {
      expect(
        await ensureBranchProtection(
          makeClient({ reads, writeError: err }),
          org,
        ),
      ).toMatchSnapshot()
    })
  }
})

describe("ensureOrgActionsEnabled", () => {
  const perms = `/orgs/${org}/actions/permissions`
  const reads = {
    [perms]: { enabled_repositories: "none", allowed_actions: "local_only" },
  }
  it("succeeds", async () => {
    expect(
      await ensureOrgActionsEnabled(makeClient({ reads }), org),
    ).toMatchSnapshot()
  })
  for (const [label, err] of failures) {
    it(`warns on ${label}`, async () => {
      expect(
        await ensureOrgActionsEnabled(
          makeClient({ reads, writeError: err }),
          org,
        ),
      ).toMatchSnapshot()
    })
  }
  it("warns on 500 when the readback also fails", async () => {
    expect(
      await ensureOrgActionsEnabled(
        makeClient({
          reads: { [perms]: plainError },
          writeError: apiError(500),
        }),
        org,
      ),
    ).toMatchSnapshot()
  })
})

describe("ensureOrgCanCreatePullRequests", () => {
  const path = `/orgs/${org}/actions/permissions/workflow`
  const reads = {
    [path]: {
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: false,
    },
  }
  it("succeeds", async () => {
    expect(
      await ensureOrgCanCreatePullRequests(makeClient({ reads }), org),
    ).toMatchSnapshot()
  })
  it("is already complete", async () => {
    expect(
      await ensureOrgCanCreatePullRequests(
        makeClient({
          reads: {
            [path]: {
              default_workflow_permissions: "read",
              can_approve_pull_request_reviews: true,
            },
          },
        }),
        org,
      ),
    ).toMatchSnapshot()
  })
  it("warns when the readback fails", async () => {
    expect(
      await ensureOrgCanCreatePullRequests(
        makeClient({ reads: { [path]: plainError } }),
        org,
      ),
    ).toMatchSnapshot()
  })
  for (const [label, err] of failures) {
    it(`handles ${label}`, async () => {
      await expect(
        ensureOrgCanCreatePullRequests(
          makeClient({ reads, writeError: err }),
          org,
        ).then(
          (r) => ({ resolved: r }),
          (e) => ({ rejected: String(e) }),
        ),
      ).resolves.toMatchSnapshot()
    })
  }
})

describe("ensureOrgActionsBudgetCap", () => {
  const path = `/organizations/${org}/settings/billing/budgets`
  const reads = { [path]: { budgets: [] } }
  it("creates the cap", async () => {
    expect(
      await ensureOrgActionsBudgetCap(makeClient({ reads }), org),
    ).toMatchSnapshot()
  })
  it("warns when the readback fails", async () => {
    expect(
      await ensureOrgActionsBudgetCap(
        makeClient({ reads: { [path]: plainError } }),
        org,
      ),
    ).toMatchSnapshot()
  })
  for (const [label, err] of failures) {
    it(`warns on ${label}`, async () => {
      expect(
        await ensureOrgActionsBudgetCap(
          makeClient({ reads, writeError: err }),
          org,
        ),
      ).toMatchSnapshot()
    })
  }
})

describe("setOrgActionsMode", () => {
  // A fully disabled org, so resume reaches the write instead of no-op'ing.
  const reads = {
    [`/orgs/${org}/actions/permissions`]: { enabled_repositories: "none" },
  }
  for (const [label, err] of failures) {
    it(`warns on ${label} when resuming`, async () => {
      expect(
        await setOrgActionsMode(
          makeClient({ reads, writeError: err }),
          org,
          "active",
        ),
      ).toMatchSnapshot()
    })
  }
})
