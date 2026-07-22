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
  repositories?: { repositories: { id: number; name: string }[] } | Error
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
      repositories: { repositories: [{ id: 1, name: "classroom50" }] },
    })
    expect(await getOrgActionsMode(client, org)).toBe("paused")
  })

  it("returns 'active' for a 'selected' policy that excludes classroom50 (not ours)", async () => {
    const { client } = makeClient({
      perms: { enabled_repositories: "selected" },
      repositories: { repositories: [{ id: 2, name: "some-other-repo" }] },
    })
    expect(await getOrgActionsMode(client, org)).toBe("active")
  })

  it("returns 'unknown' when the policy read fails", async () => {
    const { client } = makeClient({ perms: apiError(403) })
    expect(await getOrgActionsMode(client, org)).toBe("unknown")
  })
})

describe("setOrgActionsMode", () => {
  it("pause switches to 'selected' first, then sets the allow-list to the config repo", async () => {
    const { client, calls } = makeClient({ repo: { id: 42 } })
    const result = await setOrgActionsMode(client, org, "paused")
    expect(result.status).toBe("complete")

    const writes = calls.filter((c) => c.method === "PUT")
    expect(writes[0].path).toBe(`/orgs/${org}/actions/permissions`)
    expect(writes[0].body).toMatchObject({ enabled_repositories: "selected" })
    expect(writes[1].path).toBe(`/orgs/${org}/actions/permissions/repositories`)
    expect(writes[1].body).toEqual({ selected_repository_ids: [42] })
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

  it("resume re-enables Actions for all repositories", async () => {
    const { client, calls } = makeClient({})
    const result = await setOrgActionsMode(client, org, "active")
    expect(result).toMatchObject({ status: "complete", mode: "active" })
    const write = calls.find((c) => c.method === "PUT")
    expect(write?.path).toBe(`/orgs/${org}/actions/permissions`)
    expect(write?.body).toMatchObject({ enabled_repositories: "all" })
  })

  it("maps a 403 on resume to a permission_denied warning", async () => {
    const request = async (_path: string, options?: { method?: string }) => {
      if (options?.method === "PUT") throw apiError(403)
      return {}
    }
    const client = { request } as unknown as GitHubClient
    const result = await setOrgActionsMode(client, org, "active")
    expect(result).toMatchObject({
      status: "warning",
      reason: "permission_denied",
    })
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
        return { repositories: [{ id: 1, name: "classroom50" }] }
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
})
