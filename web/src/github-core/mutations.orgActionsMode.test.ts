import { describe, expect, it } from "vitest"

import {
  ensureOrgActionsEnabled,
  getOrgActionsMode,
  setOrgActionsMode,
} from "./mutations"
import { GitHubAPIError } from "./errors"
import type { GitHubClient } from "./client"

const org = "acme"

const rateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const apiError = (status: number, message = `http ${status}`) =>
  new GitHubAPIError({
    status,
    url: `/orgs/${org}/actions/permissions`,
    message,
    body: {},
    rateLimit,
  })

type Handlers = {
  perms?: { enabled_repositories: string; allowed_actions?: string } | Error
  repositories?:
    | { total_count: number; repositories: { id: number; name: string }[] }
    | Error
  repo?: { id: number } | null | Error
}

type Call = { method: string; path: string; body?: unknown }

// A fake GitHubClient routing on "METHOD path". Records writes so the pause
// ordering (PUT permissions before PUT repositories) is assertable.
function makeClient(handlers: Handlers) {
  const calls: Call[] = []
  const request = async (
    path: string,
    options?: { method?: string; body?: unknown },
  ) => {
    const method = options?.method ?? "GET"
    calls.push({ method, path, body: options?.body })

    if (path === `/orgs/${org}/actions/permissions` && method === "GET") {
      if (handlers.perms instanceof Error) throw handlers.perms
      return handlers.perms
    }
    if (
      path.startsWith(`/orgs/${org}/actions/permissions/repositories`) &&
      method === "GET"
    ) {
      if (handlers.repositories instanceof Error) throw handlers.repositories
      return handlers.repositories
    }
    if (path === `/repos/${org}/classroom50` && method === "GET") {
      if (handlers.repo instanceof Error) throw handlers.repo
      // getRepo tolerates 404 -> null; simulate a not-found by throwing 404.
      if (handlers.repo === null) throw apiError(404)
      return handlers.repo
    }
    // Writes (PUT) just record and resolve.
    return {}
  }
  return { client: { request } as unknown as GitHubClient, calls }
}

describe("getOrgActionsMode", () => {
  it("returns 'active' when Actions are enabled for all repos", async () => {
    const { client } = makeClient({
      perms: { enabled_repositories: "all", allowed_actions: "all" },
    })
    expect(await getOrgActionsMode(client, org)).toBe("active")
  })

  it("returns 'paused' when restricted to selected repos including classroom50", async () => {
    const { client } = makeClient({
      perms: { enabled_repositories: "selected" },
      repositories: {
        total_count: 1,
        repositories: [{ id: 1, name: "classroom50" }],
      },
    })
    expect(await getOrgActionsMode(client, org)).toBe("paused")
  })

  it("returns 'active' for a 'selected' policy that excludes classroom50 (not ours)", async () => {
    const { client } = makeClient({
      perms: { enabled_repositories: "selected" },
      repositories: {
        total_count: 1,
        repositories: [{ id: 2, name: "some-other-repo" }],
      },
    })
    expect(await getOrgActionsMode(client, org)).toBe("active")
  })

  it("returns 'disabled' when Actions are off for every repo (none)", async () => {
    const { client } = makeClient({
      perms: { enabled_repositories: "none" },
    })
    expect(await getOrgActionsMode(client, org)).toBe("disabled")
  })

  it("returns 'unknown' when the policy read fails", async () => {
    const { client } = makeClient({ perms: apiError(403) })
    expect(await getOrgActionsMode(client, org)).toBe("unknown")
  })

  it("paginates the selection list; finds classroom50 on a later page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: 1000 + i,
      name: `repo-${i}`,
    }))
    const request = async (path: string) => {
      if (path === `/orgs/${org}/actions/permissions`)
        return { enabled_repositories: "selected" }
      if (path.includes("/repositories")) {
        const page = Number(
          new URL(`https://x${path}`).searchParams.get("page"),
        )
        return page === 1
          ? { total_count: 101, repositories: page1 }
          : { total_count: 101, repositories: [{ id: 9, name: "classroom50" }] }
      }
      return {}
    }
    const client = { request } as unknown as GitHubClient
    expect(await getOrgActionsMode(client, org)).toBe("paused")
  })
})

describe("setOrgActionsMode", () => {
  it("pause switches to 'selected' first, then sets the allow-list to the config repo", async () => {
    const { client, calls } = makeClient({
      repo: { id: 42 },
      // Read-back after the writes confirms the config repo landed.
      repositories: {
        total_count: 1,
        repositories: [{ id: 42, name: "classroom50" }],
      },
    })
    const result = await setOrgActionsMode(client, org, "paused")
    expect(result.status).toBe("complete")

    const writes = calls.filter((c) => c.method === "PUT")
    expect(writes[0].path).toBe(`/orgs/${org}/actions/permissions`)
    expect(writes[0].body).toEqual({ enabled_repositories: "selected" })
    // Must NOT clobber a teacher's allowed_actions posture on pause.
    expect(writes[0].body).not.toHaveProperty("allowed_actions")
    expect(writes[1].path).toBe(`/orgs/${org}/actions/permissions/repositories`)
    expect(writes[1].body).toEqual({ selected_repository_ids: [42] })
  })

  it("pause warns when the read-back shows the config repo isn't allow-listed", async () => {
    const { client } = makeClient({
      repo: { id: 42 },
      // Writes 2xx, but the effective selection doesn't include the config repo.
      repositories: {
        total_count: 1,
        repositories: [{ id: 99, name: "other" }],
      },
    })
    const result = await setOrgActionsMode(client, org, "paused")
    expect(result).toMatchObject({ status: "warning", reason: "failed" })
  })

  it("pause warns (readback_failed) when the verify read itself throws", async () => {
    // Writes succeed but the confirmation read fails — fail closed rather than
    // report a clean pause we couldn't verify.
    const { client } = makeClient({
      repo: { id: 42 },
      repositories: apiError(500),
    })
    const result = await setOrgActionsMode(client, org, "paused")
    expect(result).toMatchObject({
      status: "warning",
      reason: "readback_failed",
    })
  })

  it("pause maps a non-404 getRepo failure to a structured warning", async () => {
    const { client } = makeClient({ repo: apiError(403) })
    const result = await setOrgActionsMode(client, org, "paused")
    expect(result).toMatchObject({
      status: "warning",
      reason: "permission_denied",
    })
  })

  it("pause warns (no writes) when the config repo is missing", async () => {
    const { client, calls } = makeClient({ repo: null })
    const result = await setOrgActionsMode(client, org, "paused")
    expect(result).toMatchObject({
      status: "warning",
      reason: "config_repo_missing",
    })
    expect(calls.some((c) => c.method === "PUT")).toBe(false)
  })

  it("resume re-enables Actions for all repositories when currently paused", async () => {
    const { client, calls } = makeClient({
      perms: { enabled_repositories: "selected" },
      repositories: {
        total_count: 1,
        repositories: [{ id: 1, name: "classroom50" }],
      },
    })
    const result = await setOrgActionsMode(client, org, "active")
    expect(result).toMatchObject({ status: "complete", mode: "active" })
    const write = calls.find((c) => c.method === "PUT")
    expect(write?.path).toBe(`/orgs/${org}/actions/permissions`)
    expect(write?.body).toMatchObject({ enabled_repositories: "all" })
  })

  it("resume is a no-op (no writes) when the org isn't on our pause", async () => {
    // A teacher's own "selected" allow-list that excludes classroom50: resuming
    // must NOT force "all" and widen it.
    const { client, calls } = makeClient({
      perms: { enabled_repositories: "selected" },
      repositories: {
        total_count: 1,
        repositories: [{ id: 9, name: "some-repo" }],
      },
    })
    const result = await setOrgActionsMode(client, org, "active")
    expect(result).toMatchObject({ status: "complete", mode: "active" })
    expect(calls.some((c) => c.method === "PUT")).toBe(false)
  })

  it("resume warns (not success) when the policy is unreadable", async () => {
    // An unreadable policy must surface as a warning, not a green success toast
    // that hides the failure while the toggle stays put.
    const { client, calls } = makeClient({ perms: apiError(403) })
    const result = await setOrgActionsMode(client, org, "active")
    expect(result).toMatchObject({
      status: "warning",
      reason: "readback_failed",
    })
    expect(calls.some((c) => c.method === "PUT")).toBe(false)
  })

  it("resume enables 'all' from a fully-disabled org", async () => {
    const { client, calls } = makeClient({
      perms: { enabled_repositories: "none" },
    })
    const result = await setOrgActionsMode(client, org, "active")
    expect(result).toMatchObject({ status: "complete", mode: "active" })
    const write = calls.find((c) => c.method === "PUT")
    expect(write?.body).toMatchObject({ enabled_repositories: "all" })
  })

  it("maps a 403 on resume to a permission_denied warning", async () => {
    const request = async (path: string, options?: { method?: string }) => {
      const method = options?.method ?? "GET"
      // Report a paused state so resume proceeds to the PUT (which 403s).
      if (path === `/orgs/${org}/actions/permissions` && method === "GET")
        return { enabled_repositories: "selected" }
      if (
        path.startsWith(`/orgs/${org}/actions/permissions/repositories`) &&
        method === "GET"
      )
        return {
          total_count: 1,
          repositories: [{ id: 1, name: "classroom50" }],
        }
      if (method === "PUT") throw apiError(403)
      return {}
    }
    const client = { request } as unknown as GitHubClient
    const result = await setOrgActionsMode(client, org, "active")
    expect(result).toMatchObject({
      status: "warning",
      reason: "permission_denied",
    })
  })

  it("rolls back to 'all' and warns when the allow-list write fails mid-pause", async () => {
    const calls: Call[] = []
    const request = async (
      path: string,
      options?: { method?: string; body?: unknown },
    ) => {
      const method = options?.method ?? "GET"
      calls.push({ method, path, body: options?.body })
      if (path === `/repos/${org}/classroom50`) return { id: 42 }
      if (
        path === `/orgs/${org}/actions/permissions/repositories` &&
        method === "PUT"
      )
        throw apiError(422)
      return {}
    }
    const client = { request } as unknown as GitHubClient
    const result = await setOrgActionsMode(client, org, "paused")
    expect(result.status).toBe("warning")
    // Rolled back: the last permissions PUT restores "all".
    const permWrites = calls.filter(
      (c) =>
        c.method === "PUT" && c.path === `/orgs/${org}/actions/permissions`,
    )
    expect(
      (permWrites.at(-1)?.body as { enabled_repositories?: string })
        ?.enabled_repositories,
    ).toBe("all")
  })
})

describe("ensureOrgActionsEnabled respects an active pause", () => {
  it("leaves a config-repo pause in place instead of forcing 'all'", async () => {
    const calls: Call[] = []
    const request = async (
      path: string,
      options?: { method?: string; body?: unknown },
    ) => {
      const method = options?.method ?? "GET"
      calls.push({ method, path, body: options?.body })
      if (path === `/orgs/${org}/actions/permissions` && method === "GET")
        return { enabled_repositories: "selected", allowed_actions: "all" }
      if (path.startsWith(`/orgs/${org}/actions/permissions/repositories`))
        return {
          total_count: 1,
          repositories: [{ id: 1, name: "classroom50" }],
        }
      return {}
    }
    const client = { request } as unknown as GitHubClient
    const result = await ensureOrgActionsEnabled(client, org)
    expect(result).toMatchObject({
      status: "warning",
      reason: "autograding_paused",
      enabledRepositories: "selected",
    })
    // Must NOT have flipped the policy back to "all".
    expect(
      calls.some(
        (c) =>
          c.method === "PUT" &&
          c.path === `/orgs/${org}/actions/permissions` &&
          (c.body as { enabled_repositories?: string })
            ?.enabled_repositories === "all",
      ),
    ).toBe(false)
  })

  it("still enables Actions when the org is set to 'none'", async () => {
    const calls: Call[] = []
    const request = async (
      path: string,
      options?: { method?: string; body?: unknown },
    ) => {
      const method = options?.method ?? "GET"
      calls.push({ method, path, body: options?.body })
      if (path === `/orgs/${org}/actions/permissions` && method === "GET")
        return { enabled_repositories: "none" }
      return {}
    }
    const client = { request } as unknown as GitHubClient
    const result = await ensureOrgActionsEnabled(client, org)
    expect(result.status).toBe("complete")
    expect(
      calls.some(
        (c) =>
          c.method === "PUT" &&
          (c.body as { enabled_repositories?: string })
            ?.enabled_repositories === "all",
      ),
    ).toBe(true)
  })

  it("fails closed (warns, no 'all' write) when it can't confirm a 'selected' policy is our pause", async () => {
    // Perms read says "selected", but the inclusion check throws (transient).
    // Must NOT fall through and force "all" — that would resume student spend.
    const calls: Call[] = []
    const request = async (
      path: string,
      options?: { method?: string; body?: unknown },
    ) => {
      const method = options?.method ?? "GET"
      calls.push({ method, path, body: options?.body })
      if (path === `/orgs/${org}/actions/permissions` && method === "GET")
        return { enabled_repositories: "selected" }
      if (path.startsWith(`/orgs/${org}/actions/permissions/repositories`))
        throw apiError(500)
      return {}
    }
    const client = { request } as unknown as GitHubClient
    const result = await ensureOrgActionsEnabled(client, org)
    expect(result).toMatchObject({
      status: "warning",
      reason: "readback_failed",
      enabledRepositories: "selected",
    })
    expect(
      calls.some(
        (c) =>
          c.method === "PUT" &&
          (c.body as { enabled_repositories?: string })
            ?.enabled_repositories === "all",
      ),
    ).toBe(false)
  })

  it("still enables when a 'selected' policy is a teacher's list (not our config repo)", async () => {
    const calls: Call[] = []
    const request = async (
      path: string,
      options?: { method?: string; body?: unknown },
    ) => {
      const method = options?.method ?? "GET"
      calls.push({ method, path, body: options?.body })
      if (path === `/orgs/${org}/actions/permissions` && method === "GET")
        return { enabled_repositories: "selected" }
      if (path.startsWith(`/orgs/${org}/actions/permissions/repositories`))
        return { total_count: 1, repositories: [{ id: 7, name: "some-repo" }] }
      return {}
    }
    const client = { request } as unknown as GitHubClient
    const result = await ensureOrgActionsEnabled(client, org)
    expect(result.status).toBe("complete")
    expect(
      calls.some(
        (c) =>
          c.method === "PUT" &&
          (c.body as { enabled_repositories?: string })
            ?.enabled_repositories === "all",
      ),
    ).toBe(true)
  })
})
