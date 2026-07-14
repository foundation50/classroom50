import { describe, expect, it, vi } from "vitest"

import {
  deleteClassroomTeam,
  isDeletableClassroomTeamRef,
  TeamIdMismatchError,
} from "./mutations"
import { GitHubAPIError } from "./errors"
import type { GitHubClient } from "./client"

// classroom.json is config-repo-write authored and parsed without schema
// validation, so a team ref read from it is untrusted input to a destructive
// DELETE. These tests pin the guard that keeps a drifted ref from steering a
// delete into an unrelated org team.

function apiError(status: number): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: "x",
    message: "err",
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

// A fake client recording GETs (live-id checks) and DELETEs (actual deletions).
function makeClient(liveId = 11) {
  const deletes: string[] = []
  const gets: string[] = []
  const request = vi.fn(
    async (path: string, init?: { method?: string }): Promise<unknown> => {
      if (init?.method === "DELETE") {
        deletes.push(path)
        return undefined
      }
      gets.push(path)
      return { id: liveId }
    },
  )
  const client = { request } as unknown as GitHubClient
  return { client, deletes, gets }
}

describe("isDeletableClassroomTeamRef", () => {
  it("accepts a classroom50- ref with a positive integer id", () => {
    expect(
      isDeletableClassroomTeamRef({ id: 11, slug: "classroom50-cs101" }),
    ).toBe(true)
    expect(
      isDeletableClassroomTeamRef({ id: 7, slug: "classroom50-cs101-ta" }),
    ).toBe(true)
  })

  it("rejects a ref outside the classroom50- namespace", () => {
    expect(isDeletableClassroomTeamRef({ id: 5, slug: "admins" })).toBe(false)
    expect(isDeletableClassroomTeamRef({ id: 5, slug: "owners" })).toBe(false)
  })

  it("rejects a falsy / non-positive / non-integer id (which would skip the live-id guard)", () => {
    expect(
      isDeletableClassroomTeamRef({ id: 0, slug: "classroom50-cs101" }),
    ).toBe(false)
    expect(
      isDeletableClassroomTeamRef({ id: -1, slug: "classroom50-cs101" }),
    ).toBe(false)
    expect(
      isDeletableClassroomTeamRef({ id: 1.5, slug: "classroom50-cs101" }),
    ).toBe(false)
  })

  it("rejects a missing slug/id or nullish ref", () => {
    expect(isDeletableClassroomTeamRef(undefined)).toBe(false)
    expect(isDeletableClassroomTeamRef(null)).toBe(false)
    expect(isDeletableClassroomTeamRef({ slug: "classroom50-cs101" })).toBe(
      false,
    )
    expect(isDeletableClassroomTeamRef({ id: 11 })).toBe(false)
  })
})

describe("deleteClassroomTeam fail-closed guard", () => {
  it("refuses (no GET, no DELETE) a ref outside the classroom50- namespace", async () => {
    const { client, deletes, gets } = makeClient()
    await deleteClassroomTeam(client, "acme", {
      id: 5,
      slug: "admins",
    })
    expect(deletes).toEqual([])
    expect(gets).toEqual([])
  })

  it("refuses a classroom50- ref with a falsy id (would otherwise delete the slug blind)", async () => {
    const { client, deletes, gets } = makeClient()
    await deleteClassroomTeam(client, "acme", {
      id: 0,
      slug: "classroom50-cs101",
    } as unknown as { id: number; slug: string })
    expect(deletes).toEqual([])
    expect(gets).toEqual([])
  })

  it("deletes a well-formed classroom50- ref after confirming the live id matches", async () => {
    const { client, deletes, gets } = makeClient(11)
    await deleteClassroomTeam(client, "acme", {
      id: 11,
      slug: "classroom50-cs101-ta",
    })
    expect(gets).toEqual(["/orgs/acme/teams/classroom50-cs101-ta"])
    expect(deletes).toEqual(["/orgs/acme/teams/classroom50-cs101-ta"])
  })

  it("refuses to delete when the live id no longer matches (reused slug)", async () => {
    const { client, deletes } = makeClient(999)
    await expect(
      deleteClassroomTeam(client, "acme", {
        id: 11,
        slug: "classroom50-cs101",
      }),
    ).rejects.toBeInstanceOf(TeamIdMismatchError)
    expect(deletes).toEqual([])
  })

  it("treats an already-gone team (404 on the live-id read) as success", async () => {
    const deletes: string[] = []
    const request = vi.fn(
      async (_path: string, init?: { method?: string }): Promise<unknown> => {
        if (init?.method === "DELETE") {
          deletes.push(_path)
          return undefined
        }
        throw apiError(404)
      },
    )
    const client = { request } as unknown as GitHubClient
    await expect(
      deleteClassroomTeam(client, "acme", {
        id: 11,
        slug: "classroom50-cs101",
      }),
    ).resolves.toBeUndefined()
    expect(deletes).toEqual([])
  })

  // The live-id GET matches, so we reach the DELETE; a 404 there (deleted
  // between check and delete) is tolerated as success.
  it("tolerates a 404 on the DELETE itself (gone between check and delete)", async () => {
    const request = vi.fn(
      async (_path: string, init?: { method?: string }): Promise<unknown> => {
        if (init?.method === "DELETE") throw apiError(404)
        return { id: 11 }
      },
    )
    const client = { request } as unknown as GitHubClient
    await expect(
      deleteClassroomTeam(client, "acme", {
        id: 11,
        slug: "classroom50-cs101-ta",
      }),
    ).resolves.toBeUndefined()
  })

  // A non-404 failure on the DELETE must propagate — never silently swallowed.
  it("rethrows a non-404 error on the DELETE", async () => {
    const request = vi.fn(
      async (_path: string, init?: { method?: string }): Promise<unknown> => {
        if (init?.method === "DELETE") throw apiError(500)
        return { id: 11 }
      },
    )
    const client = { request } as unknown as GitHubClient
    await expect(
      deleteClassroomTeam(client, "acme", {
        id: 11,
        slug: "classroom50-cs101-ta",
      }),
    ).rejects.toBeInstanceOf(GitHubAPIError)
  })
})
