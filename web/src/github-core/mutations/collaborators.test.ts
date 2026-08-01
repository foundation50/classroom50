import { describe, expect, it, vi } from "vitest"

import { addRepoCollaborator } from "./collaborators"
import { GitHubAPIError } from "../errors"
import type { GitHubClient } from "../client"

const ORG = "cs50"
const REPO = "cs50-fall-2026-hello-alice"
const USER = "alice"
const memberPath = `/orgs/${ORG}/members/${USER}`
const collabPath = `/repos/${ORG}/${REPO}/collaborators/${USER}`
const permPath = `${collabPath}/permission`

function apiError(status: number): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: permPath,
    message: `HTTP ${status}`,
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

// requestRaw handles the org-membership pre-check and the collaborator PUT;
// request handles the effective-permission read-back. `readBack` is either the
// value the /permission GET returns, or an error it throws (a lagging 404 or a
// transient), so a test can drive the unverified path.
function makeClient(opts: {
  memberCheck?: "ok" | GitHubAPIError
  put?: "ok" | GitHubAPIError
  readBack?: { permission?: string; role_name?: string } | GitHubAPIError
}) {
  const { memberCheck = "ok", put = "ok", readBack } = opts
  const requestRaw = vi.fn(async (path: string) => {
    if (path === memberPath) {
      if (memberCheck instanceof GitHubAPIError) throw memberCheck
      return undefined
    }
    if (path === collabPath) {
      if (put instanceof GitHubAPIError) throw put
      return undefined
    }
    throw new Error(`unexpected requestRaw: ${path}`)
  })
  const request = vi.fn(async (path: string) => {
    if (path === permPath) {
      if (readBack instanceof GitHubAPIError) throw readBack
      return readBack
    }
    throw new Error(`unexpected request: ${path}`)
  })
  return {
    client: { request, requestRaw } as unknown as GitHubClient,
    request,
    requestRaw,
  }
}

describe("addRepoCollaborator", () => {
  it("without verify: PUTs the role and issues NO read-back", async () => {
    const { client, request, requestRaw } = makeClient({})
    const result = await addRepoCollaborator({
      client,
      org: ORG,
      repo: REPO,
      username: USER,
      permission: "pull",
    })
    expect(result).toEqual({})
    // The PUT went out with the requested role...
    expect(requestRaw).toHaveBeenCalledWith(collabPath, {
      method: "PUT",
      body: { permission: "pull" },
    })
    // ...and the permission sub-resource was never read.
    expect(request).not.toHaveBeenCalled()
  })

  it("with verify: reads the effective permission back and returns it", async () => {
    const { client, request } = makeClient({
      readBack: { permission: "read", role_name: "pull" },
    })
    const result = await addRepoCollaborator({
      client,
      org: ORG,
      repo: REPO,
      username: USER,
      permission: "pull",
      verify: true,
    })
    expect(result).toEqual({
      effective: { permission: "read", role_name: "pull" },
    })
    expect(request).toHaveBeenCalledWith(permPath)
  })

  it("with verify: a lagging 404 read-back returns effective:undefined, not a failure", async () => {
    // The /collaborators/{u}/permission sub-resource lags a fresh PUT by an
    // unbounded window; a 404 there means "not readable yet", not that the
    // (already-succeeded) write failed. The caller treats undefined as
    // issued-but-unconfirmed and must NOT surface it as a failed write.
    const { client } = makeClient({ readBack: apiError(404) })
    const result = await addRepoCollaborator({
      client,
      org: ORG,
      repo: REPO,
      username: USER,
      permission: "pull",
      verify: true,
    })
    expect(result).toEqual({ effective: undefined })
  })

  it("with verify: a transient read-back error (5xx) is also unverified, not a failure", async () => {
    const { client } = makeClient({ readBack: apiError(502) })
    const result = await addRepoCollaborator({
      client,
      org: ORG,
      repo: REPO,
      username: USER,
      permission: "push",
      verify: true,
    })
    expect(result).toEqual({ effective: undefined })
  })

  it("propagates a definitive 404 from the org-membership pre-check (not a member)", async () => {
    const err = apiError(404)
    const { client, requestRaw } = makeClient({ memberCheck: err })
    await expect(
      addRepoCollaborator({
        client,
        org: ORG,
        repo: REPO,
        username: USER,
        permission: "push",
      }),
    ).rejects.toBe(err)
    // Blocked before the collaborator PUT.
    expect(requestRaw).not.toHaveBeenCalledWith(collabPath, expect.anything())
  })

  it("propagates a genuine PUT failure (the write itself erroring)", async () => {
    const err = apiError(422)
    const { client } = makeClient({ put: err })
    await expect(
      addRepoCollaborator({
        client,
        org: ORG,
        repo: REPO,
        username: USER,
        permission: "push",
        verify: true,
      }),
    ).rejects.toBe(err)
  })
})
