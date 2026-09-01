import { describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import {
  assertGroupMemberAddable,
  createGroupTeam,
  deleteGroupTeam,
  findMyGroupTeam,
  leaveGroupTeam,
  lowestFreeCounter,
  takenCounters,
  updateGroupTeamDisplayName,
} from "./groupTeams"
import { groupTeamAssignmentPrefix, groupTeamName } from "@/util/teamSlug"
import { marshalGroupDescription } from "@/util/groupTeam"
import { localizedMessageOf } from "@/types/localizedMessage"

const ORG = "cs50"
const CLASSROOM = "cs-fall"
const ASSIGNMENT = "hw1"

function apiError(status: number, message: string): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: "test",
    message,
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

describe("lowestFreeCounter / takenCounters", () => {
  it("starts at 1 and skips taken counters", () => {
    expect(lowestFreeCounter(new Set())).toBe(1)
    expect(lowestFreeCounter(new Set([1, 2, 4]))).toBe(3)
    expect(lowestFreeCounter(new Set([2, 3]))).toBe(1)
  })

  it("takenCounters parses only this assignment's team slugs", async () => {
    const prefix = await groupTeamAssignmentPrefix(CLASSROOM, ASSIGNMENT)
    const otherPrefix = await groupTeamAssignmentPrefix(CLASSROOM, "hw2")
    const teams = [
      { slug: `${prefix}1` },
      { slug: `${prefix}3` },
      { slug: `${otherPrefix}2` },
      { slug: "classroom50-cs-fall" },
      { slug: `${prefix}02` }, // leading zero: not a canonical counter
    ]
    expect([...takenCounters(teams, prefix)].sort()).toEqual([1, 3])
  })
})

describe("assertGroupMemberAddable", () => {
  it("throws a localized group-full error at capacity", () => {
    try {
      assertGroupMemberAddable({
        username: "bob",
        currentMemberCount: 3,
        maxGroupSize: 3,
      })
      throw new Error("expected to throw")
    } catch (err) {
      expect(localizedMessageOf(err)?.key).toBe("groupTeams.errors.groupFull")
    }
  })

  it("throws a localized not-on-roster error for a non-roster login", () => {
    try {
      assertGroupMemberAddable({
        username: "Mallory",
        currentMemberCount: 1,
        maxGroupSize: 3,
        rosterLogins: new Set(["alice", "bob"]),
      })
      throw new Error("expected to throw")
    } catch (err) {
      expect(localizedMessageOf(err)?.key).toBe("groupTeams.errors.notOnRoster")
    }
  })

  it("passes under capacity for a roster login (case-insensitive)", () => {
    expect(() =>
      assertGroupMemberAddable({
        username: "Alice",
        currentMemberCount: 1,
        maxGroupSize: 3,
        rosterLogins: new Set(["alice"]),
      }),
    ).not.toThrow()
  })
})

describe("createGroupTeam counter allocation", () => {
  // A client whose org team listing shows `visibleCounters` and whose create
  // 422s for every name in `takenNames` (a secret team invisible to the
  // caller), succeeding otherwise.
  function makeClient(opts: {
    visibleSlugs: string[]
    conflictNames?: Set<string>
  }) {
    const created: string[] = []
    const createdBodies: Record<string, unknown>[] = []
    const memberships: string[] = []
    const request = vi.fn(
      async (
        url: string,
        init?: { method?: string; body?: Record<string, unknown> },
      ) => {
        const method = init?.method ?? "GET"
        if (method === "GET" && url.startsWith(`/orgs/${ORG}/teams?`)) {
          return opts.visibleSlugs.map((slug, i) => ({
            slug,
            id: i + 1,
            name: slug,
            description: null,
            privacy: "secret",
          }))
        }
        if (method === "POST" && url === `/orgs/${ORG}/teams`) {
          const name = String(init?.body?.name)
          if (opts.conflictNames?.has(name)) {
            throw apiError(422, "Name must be unique for this org")
          }
          created.push(name)
          createdBodies.push(init?.body ?? {})
          return { id: 999, slug: name, name, description: null }
        }
        if (method === "DELETE" && url.includes("/memberships/")) {
          memberships.push(`DELETE ${url}`)
          return undefined
        }
        if (method === "PUT" && url.includes("/memberships/")) {
          memberships.push(`PUT ${url}`)
          return undefined
        }
        throw new Error(`unexpected request: ${method} ${url}`)
      },
    )
    return {
      client: { request } as unknown as GitHubClient,
      created,
      createdBodies,
      memberships,
    }
  }

  it("seeds from the visible listing (lowest free n)", async () => {
    const prefix = await groupTeamAssignmentPrefix(CLASSROOM, ASSIGNMENT)
    const { client, created } = makeClient({
      visibleSlugs: [`${prefix}1`, `${prefix}2`],
    })
    const result = await createGroupTeam(client, ORG, {
      classroom: CLASSROOM,
      assignment: ASSIGNMENT,
      creatorLogin: "alice",
      founderLogin: "alice",
      formation: "student",
    })
    expect(result.n).toBe(3)
    expect(created).toEqual([await groupTeamName(CLASSROOM, ASSIGNMENT, 3)])
  })

  it("retries past a 422 from an invisible secret team", async () => {
    const prefix = await groupTeamAssignmentPrefix(CLASSROOM, ASSIGNMENT)
    const n1 = `${prefix}1`
    const n2 = `${prefix}2`
    const { client, created } = makeClient({
      visibleSlugs: [],
      // Counters 1 and 2 are taken by teams the caller can't see.
      conflictNames: new Set([n1, n2]),
    })
    const result = await createGroupTeam(client, ORG, {
      classroom: CLASSROOM,
      assignment: ASSIGNMENT,
      creatorLogin: "alice",
      founderLogin: "alice",
      formation: "student",
    })
    expect(result.n).toBe(3)
    expect(created).toEqual([`${prefix}3`])
  })

  it("student formation keeps the founding creator (no membership writes)", async () => {
    const { client, memberships } = makeClient({ visibleSlugs: [] })
    await createGroupTeam(client, ORG, {
      classroom: CLASSROOM,
      assignment: ASSIGNMENT,
      creatorLogin: "alice",
      founderLogin: "alice",
      formation: "student",
    })
    expect(memberships).toEqual([])
  })

  it("teacher formation drops the creating teacher", async () => {
    const { client, memberships } = makeClient({ visibleSlugs: [] })
    await createGroupTeam(client, ORG, {
      classroom: CLASSROOM,
      assignment: ASSIGNMENT,
      creatorLogin: "teacher",
      formation: "teacher",
    })
    expect(memberships).toHaveLength(1)
    expect(memberships[0]).toMatch(/^DELETE .*\/memberships\/teacher$/)
  })

  it("visibility follows the formation: student closed, teacher secret", async () => {
    // Student-formed teams must be browsable (and carry GitHub's native
    // request-to-join, which only exists on visible teams); teacher-formed
    // teams stay hidden from other classes sharing the org.
    const student = makeClient({ visibleSlugs: [] })
    await createGroupTeam(student.client, ORG, {
      classroom: CLASSROOM,
      assignment: ASSIGNMENT,
      creatorLogin: "alice",
      founderLogin: "alice",
      formation: "student",
    })
    expect(student.createdBodies[0].privacy).toBe("closed")

    const teacher = makeClient({ visibleSlugs: [] })
    await createGroupTeam(teacher.client, ORG, {
      classroom: CLASSROOM,
      assignment: ASSIGNMENT,
      creatorLogin: "teacher",
      formation: "teacher",
    })
    expect(teacher.createdBodies[0].privacy).toBe("secret")
  })

  it("propagates a 403 (org restricts team creation)", async () => {
    const request = vi.fn(async (_url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET"
      if (method === "GET") return []
      throw apiError(403, "Must have admin rights")
    })
    const client = { request } as unknown as GitHubClient
    await expect(
      createGroupTeam(client, ORG, {
        classroom: CLASSROOM,
        assignment: ASSIGNMENT,
        creatorLogin: "alice",
        founderLogin: "alice",
        formation: "student",
      }),
    ).rejects.toMatchObject({ status: 403 })
  })
})

describe("findMyGroupTeam", () => {
  it("filters by org and this assignment's prefix", async () => {
    const slug = await groupTeamName(CLASSROOM, ASSIGNMENT, 2)
    const otherOrgTeam = {
      slug,
      id: 1,
      description: null,
      organization: { login: "other-org", id: 2 },
    }
    const mine = {
      slug,
      id: 42,
      description: marshalGroupDescription({
        classroom: CLASSROOM,
        assignment: ASSIGNMENT,
        name: "The Segfaults",
      }),
      organization: { login: ORG, id: 1 },
    }
    const request = vi.fn(async (url: string) => {
      if (url.startsWith("/user/teams")) return [otherOrgTeam, mine]
      throw new Error(`unexpected request: GET ${url}`)
    })
    const client = { request } as unknown as GitHubClient
    const result = await findMyGroupTeam(client, ORG, CLASSROOM, ASSIGNMENT)
    expect(result).toEqual({
      slug,
      id: 42,
      n: 2,
      name: "The Segfaults",
    })
  })

  it("returns null when the viewer is on no team of this assignment", async () => {
    const request = vi.fn(async () => [])
    const client = { request } as unknown as GitHubClient
    await expect(
      findMyGroupTeam(client, ORG, CLASSROOM, ASSIGNMENT),
    ).resolves.toBeNull()
  })
})

describe("deleteGroupTeam guards", () => {
  function makeClient(live: {
    id: number
    description: string | null
    missing?: boolean
  }) {
    const deletes: string[] = []
    const request = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET"
      if (method === "GET" && url.includes("/teams/")) {
        if (live.missing) throw apiError(404, "Not Found")
        return {
          id: live.id,
          slug: decodeURIComponent(url.split("/teams/")[1]),
          description: live.description,
          privacy: "secret",
        }
      }
      if (method === "DELETE") {
        deletes.push(url)
        return undefined
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    })
    return { client: { request } as unknown as GitHubClient, deletes }
  }

  it("refuses a slug outside the full group-team shape", async () => {
    const { client, deletes } = makeClient({ id: 1, description: null })
    await expect(
      deleteGroupTeam(client, ORG, {
        slug: "classroom50-cs-fall",
        id: 1,
        classroom: CLASSROOM,
        assignment: ASSIGNMENT,
      }),
    ).rejects.toSatisfy(
      (err) =>
        localizedMessageOf(err)?.key === "groupTeams.errors.notAGroupTeam",
    )
    expect(deletes).toEqual([])
  })

  it("refuses when the live id doesn't match the recorded id", async () => {
    const slug = await groupTeamName(CLASSROOM, ASSIGNMENT, 1)
    const record = marshalGroupDescription({
      classroom: CLASSROOM,
      assignment: ASSIGNMENT,
    })
    const { client, deletes } = makeClient({ id: 999, description: record })
    await expect(
      deleteGroupTeam(client, ORG, {
        slug,
        id: 42,
        classroom: CLASSROOM,
        assignment: ASSIGNMENT,
      }),
    ).rejects.toSatisfy(
      (err) => localizedMessageOf(err)?.key === "groupTeams.errors.idMismatch",
    )
    expect(deletes).toEqual([])
  })

  it("refuses a team whose record doesn't verify (re-attributed description)", async () => {
    const slug = await groupTeamName(CLASSROOM, ASSIGNMENT, 1)
    // A record claiming ANOTHER assignment can't hash back to this slug.
    const foreign = marshalGroupDescription({
      classroom: CLASSROOM,
      assignment: "hw2",
    })
    const { client, deletes } = makeClient({ id: 42, description: foreign })
    await expect(
      deleteGroupTeam(client, ORG, {
        slug,
        id: 42,
        classroom: CLASSROOM,
        assignment: ASSIGNMENT,
      }),
    ).rejects.toSatisfy(
      (err) =>
        localizedMessageOf(err)?.key === "groupTeams.errors.recordMismatch",
    )
    expect(deletes).toEqual([])
  })

  it("deletes a fully verified team", async () => {
    const slug = await groupTeamName(CLASSROOM, ASSIGNMENT, 1)
    const record = marshalGroupDescription({
      classroom: CLASSROOM,
      assignment: ASSIGNMENT,
    })
    const { client, deletes } = makeClient({ id: 42, description: record })
    await deleteGroupTeam(client, ORG, {
      slug,
      id: 42,
      classroom: CLASSROOM,
      assignment: ASSIGNMENT,
    })
    expect(deletes).toHaveLength(1)
  })

  it("treats an already-gone team (404) as success", async () => {
    const slug = await groupTeamName(CLASSROOM, ASSIGNMENT, 1)
    const { client, deletes } = makeClient({
      id: 42,
      description: null,
      missing: true,
    })
    await expect(
      deleteGroupTeam(client, ORG, {
        slug,
        id: 42,
        classroom: CLASSROOM,
        assignment: ASSIGNMENT,
      }),
    ).resolves.toBeUndefined()
    expect(deletes).toEqual([])
  })
})

describe("updateGroupTeamDisplayName", () => {
  function makeClient() {
    const patches: { url: string; body: unknown }[] = []
    const request = vi.fn(
      async (url: string, init?: { method?: string; body?: unknown }) => {
        if (init?.method === "PATCH") {
          patches.push({ url, body: init.body })
          return undefined
        }
        throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`)
      },
    )
    return { client: { request } as unknown as GitHubClient, patches }
  }

  it("PATCHes only the description, re-derived with the new name", async () => {
    const slug = await groupTeamName(CLASSROOM, ASSIGNMENT, 2)
    const { client, patches } = makeClient()
    await updateGroupTeamDisplayName(client, ORG, {
      slug,
      classroom: CLASSROOM,
      assignment: ASSIGNMENT,
      name: "The Sharks",
    })
    expect(patches).toEqual([
      {
        url: `/orgs/${ORG}/teams/${slug}`,
        body: {
          description: marshalGroupDescription({
            classroom: CLASSROOM,
            assignment: ASSIGNMENT,
            name: "The Sharks",
          }),
        },
      },
    ])
    // The team NAME (== slug) must never be part of the patch — renaming the
    // display name is rename-proof for repos, grading, and cleanup only
    // because the slug stays put.
    expect(patches[0].body).not.toHaveProperty("name")
  })

  it("clears the display name when given an empty string", async () => {
    const slug = await groupTeamName(CLASSROOM, ASSIGNMENT, 2)
    const { client, patches } = makeClient()
    await updateGroupTeamDisplayName(client, ORG, {
      slug,
      classroom: CLASSROOM,
      assignment: ASSIGNMENT,
      name: "",
    })
    expect(patches[0].body).toEqual({
      description: marshalGroupDescription({
        classroom: CLASSROOM,
        assignment: ASSIGNMENT,
      }),
    })
  })

  it("refuses a slug outside the full group-team shape", async () => {
    const { client, patches } = makeClient()
    await expect(
      updateGroupTeamDisplayName(client, ORG, {
        slug: "classroom50-cs-fall",
        classroom: CLASSROOM,
        assignment: ASSIGNMENT,
        name: "The Sharks",
      }),
    ).rejects.toSatisfy(
      (err) =>
        localizedMessageOf(err)?.key === "groupTeams.errors.notAGroupTeam",
    )
    expect(patches).toEqual([])
  })
})

describe("leaveGroupTeam", () => {
  it("DELETEs the viewer's own membership", async () => {
    const slug = await groupTeamName(CLASSROOM, ASSIGNMENT, 1)
    const deletes: string[] = []
    const request = vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === "DELETE") {
        deletes.push(url)
        return undefined
      }
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`)
    })
    await leaveGroupTeam({ request } as unknown as GitHubClient, ORG, {
      teamSlug: slug,
      username: "alice",
    })
    expect(deletes).toEqual([`/orgs/${ORG}/teams/${slug}/memberships/alice`])
  })

  it("maps a 403 to the localized leave-forbidden error", async () => {
    // The REST docs only promise removal to maintainers/owners; an IdP-synced
    // team 403s a self-removal, which must never dead-end the student.
    const slug = await groupTeamName(CLASSROOM, ASSIGNMENT, 1)
    const request = vi.fn(async () => {
      throw apiError(403, "Forbidden")
    })
    await expect(
      leaveGroupTeam({ request } as unknown as GitHubClient, ORG, {
        teamSlug: slug,
        username: "alice",
      }),
    ).rejects.toSatisfy(
      (err) =>
        localizedMessageOf(err)?.key === "groupTeams.errors.leaveForbidden",
    )
  })
})
