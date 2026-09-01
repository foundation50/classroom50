import { describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import {
  assertGroupMemberAddable,
  createGroupTeam,
  deleteGroupTeam,
  findMyGroupTeam,
  leaveGroupTeam,
  listAssignmentGroupTeams,
  lowestFreeCounter,
  recoverGroupTeam,
  recreateGroupTeam,
  suggestMembersFromCommits,
  takenCounters,
  unassignedRosterStudents,
  updateGroupTeamDisplayName,
  updateGroupTeamPrivacy,
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

describe("listAssignmentGroupTeams privacy plumbing", () => {
  it("carries each team's privacy through to the ref", async () => {
    const closed = await groupTeamName(CLASSROOM, ASSIGNMENT, 1)
    const secret = await groupTeamName(CLASSROOM, ASSIGNMENT, 2)
    const request = vi.fn(async (url: string) => {
      if (url.startsWith(`/orgs/${ORG}/teams?`)) {
        return [
          { slug: closed, id: 1, description: null, privacy: "closed" },
          { slug: secret, id: 2, description: null, privacy: "secret" },
        ]
      }
      return []
    })
    const client = { request } as unknown as GitHubClient
    const refs = await listAssignmentGroupTeams(
      client,
      ORG,
      CLASSROOM,
      ASSIGNMENT,
    )
    expect(refs).toEqual([
      { slug: closed, id: 1, n: 1, privacy: "closed" },
      { slug: secret, id: 2, n: 2, privacy: "secret" },
    ])
  })

  it("omits privacy when the listing payload lacks it", async () => {
    const slug = await groupTeamName(CLASSROOM, ASSIGNMENT, 1)
    const request = vi.fn(async (url: string) => {
      if (url.startsWith(`/orgs/${ORG}/teams?`)) {
        return [{ slug, id: 1, description: null }]
      }
      return []
    })
    const client = { request } as unknown as GitHubClient
    const refs = await listAssignmentGroupTeams(
      client,
      ORG,
      CLASSROOM,
      ASSIGNMENT,
    )
    expect(refs).toHaveLength(1)
    expect("privacy" in refs[0]).toBe(false)
  })
})

describe("unassignedRosterStudents", () => {
  const rows = [
    { username: "Alice", name: "Alice A" },
    { username: "bob", name: "Bob B" },
    { username: "  ", name: "Unmatched" },
    { username: "carol", name: "Carol C" },
  ]

  it("keeps only roster rows on no group team (case-insensitive)", () => {
    const assigned = new Set(["alice", "carol"])
    expect(unassignedRosterStudents(rows, assigned)).toEqual([
      { username: "bob", name: "Bob B" },
    ])
  })

  it("drops blank usernames even when nobody is assigned", () => {
    expect(unassignedRosterStudents(rows, new Set())).toEqual([
      { username: "Alice", name: "Alice A" },
      { username: "bob", name: "Bob B" },
      { username: "carol", name: "Carol C" },
    ])
  })

  it("returns [] when everyone is grouped", () => {
    const assigned = new Set(["alice", "bob", "carol"])
    expect(unassignedRosterStudents(rows, assigned)).toEqual([])
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

describe("updateGroupTeamPrivacy", () => {
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

  it("PATCHes only the privacy", async () => {
    const slug = await groupTeamName(CLASSROOM, ASSIGNMENT, 2)
    const { client, patches } = makeClient()
    await updateGroupTeamPrivacy(client, ORG, { slug, privacy: "closed" })
    expect(patches).toEqual([
      {
        url: `/orgs/${ORG}/teams/${slug}`,
        body: { privacy: "closed" },
      },
    ])
    // Neither the team NAME (== slug, the naming contract) nor the description
    // record may ride along — a privacy flip must not rename or re-label.
    expect(patches[0].body).not.toHaveProperty("name")
    expect(patches[0].body).not.toHaveProperty("description")
  })

  it("refuses a slug outside the full group-team shape", async () => {
    const { client, patches } = makeClient()
    await expect(
      updateGroupTeamPrivacy(client, ORG, {
        slug: "classroom50-cs-fall",
        privacy: "secret",
      }),
    ).rejects.toSatisfy(
      (err) =>
        localizedMessageOf(err)?.key === "groupTeams.errors.notAGroupTeam",
    )
    expect(patches).toEqual([])
  })
})

describe("leaveGroupTeam", () => {
  function makeClient(role: string | null, opts?: { forbidDelete?: boolean }) {
    const deletes: string[] = []
    const request = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET"
      if (method === "GET" && url.includes("/memberships/")) {
        if (role === null) throw apiError(404, "Not Found")
        return { state: "active", role }
      }
      if (method === "DELETE") {
        if (opts?.forbidDelete) throw apiError(403, "Forbidden")
        deletes.push(url)
        return undefined
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    })
    return { client: { request } as unknown as GitHubClient, deletes }
  }

  it("DELETEs the viewer's own membership", async () => {
    const slug = await groupTeamName(CLASSROOM, ASSIGNMENT, 1)
    const { client, deletes } = makeClient("member")
    await leaveGroupTeam(client, ORG, { teamSlug: slug, username: "alice" })
    expect(deletes).toEqual([`/orgs/${ORG}/teams/${slug}/memberships/alice`])
  })

  it("refuses the maintainer's own exit, fail-closed in the domain", async () => {
    // The UI hides Leave for maintainers; this guard makes the rule hold for
    // every caller — a maintainer-less group would have nobody to manage it.
    const slug = await groupTeamName(CLASSROOM, ASSIGNMENT, 1)
    const { client, deletes } = makeClient("maintainer")
    await expect(
      leaveGroupTeam(client, ORG, { teamSlug: slug, username: "alice" }),
    ).rejects.toSatisfy(
      (err) =>
        localizedMessageOf(err)?.key ===
        "groupTeams.errors.maintainerCannotLeave",
    )
    expect(deletes).toEqual([])
  })

  it("maps a 403 to the localized leave-forbidden error", async () => {
    // The REST docs only promise removal to maintainers/owners; an IdP-synced
    // team 403s a self-removal, which must never dead-end the student.
    const slug = await groupTeamName(CLASSROOM, ASSIGNMENT, 1)
    const { client } = makeClient("member", { forbidDelete: true })
    await expect(
      leaveGroupTeam(client, ORG, { teamSlug: slug, username: "alice" }),
    ).rejects.toSatisfy(
      (err) =>
        localizedMessageOf(err)?.key === "groupTeams.errors.leaveForbidden",
    )
  })
})

describe("recreateGroupTeam", () => {
  // A client recording every request in order; the create 422s when
  // `conflict` is set.
  function makeClient(opts: { conflict?: boolean } = {}) {
    const calls: { method: string; url: string; body?: unknown }[] = []
    const request = vi.fn(
      async (
        url: string,
        init?: { method?: string; body?: Record<string, unknown> },
      ) => {
        const method = init?.method ?? "GET"
        calls.push({ method, url, body: init?.body })
        if (method === "POST" && url === `/orgs/${ORG}/teams`) {
          if (opts.conflict) {
            throw apiError(422, "Name must be unique for this org")
          }
          const name = String(init?.body?.name)
          return { id: 777, slug: name, name, description: null }
        }
        return undefined
      },
    )
    return { client: { request } as unknown as GitHubClient, calls }
  }

  it("creates at the EXACT counter, never a lowest-free allocation", async () => {
    // Counter 5 (the repo name's counter) even though 1..4 are free — a
    // recovery at any other n would orphan the repo again.
    const { client, calls } = makeClient()
    const result = await recreateGroupTeam(client, ORG, {
      classroom: CLASSROOM,
      assignment: ASSIGNMENT,
      n: 5,
      displayName: "The Sharks",
      privacy: "closed",
    })
    const expectedName = await groupTeamName(CLASSROOM, ASSIGNMENT, 5)
    expect(result).toEqual({ slug: expectedName, id: 777, n: 5 })
    // No listing read seeds the counter: one POST, notifications disabled,
    // carrying the caller's privacy and the group record.
    expect(calls).toEqual([
      {
        method: "POST",
        url: `/orgs/${ORG}/teams`,
        body: {
          name: expectedName,
          description: marshalGroupDescription({
            classroom: CLASSROOM,
            assignment: ASSIGNMENT,
            name: "The Sharks",
          }),
          privacy: "closed",
          notification_setting: "notifications_disabled",
        },
      },
    ])
  })

  it("maps a 422 (name taken: the team exists again) to a localized refresh error", async () => {
    const { client } = makeClient({ conflict: true })
    await expect(
      recreateGroupTeam(client, ORG, {
        classroom: CLASSROOM,
        assignment: ASSIGNMENT,
        n: 2,
        privacy: "secret",
      }),
    ).rejects.toSatisfy(
      (err) =>
        localizedMessageOf(err)?.key === "groupTeams.errors.recreateNameTaken",
    )
  })
})

describe("recoverGroupTeam", () => {
  // A client recording every request in order, with per-step failure taps.
  function makeClient(
    opts: {
      failCreate?: boolean
      failAddFor?: Set<string>
      failDrop?: boolean
    } = {},
  ) {
    const calls: { method: string; url: string; body?: unknown }[] = []
    const request = vi.fn(
      async (
        url: string,
        init?: { method?: string; body?: Record<string, unknown> },
      ) => {
        const method = init?.method ?? "GET"
        calls.push({ method, url, body: init?.body })
        if (method === "POST" && url === `/orgs/${ORG}/teams`) {
          if (opts.failCreate) throw apiError(403, "Must have admin rights")
          const name = String(init?.body?.name)
          return { id: 777, slug: name, name, description: null }
        }
        if (method === "PUT" && url.includes("/memberships/")) {
          const username = decodeURIComponent(url.split("/memberships/")[1])
          if (opts.failAddFor?.has(username)) {
            throw apiError(422, "Cannot add member")
          }
          return undefined
        }
        if (method === "PUT" && url.includes("/repos/")) return undefined
        if (method === "DELETE" && url.includes("/memberships/")) {
          if (opts.failDrop) throw apiError(403, "Forbidden")
          return undefined
        }
        if (method === "PATCH") return undefined
        throw new Error(`unexpected request: ${method} ${url}`)
      },
    )
    return { client: { request } as unknown as GitHubClient, calls }
  }

  const INPUT = {
    classroom: CLASSROOM,
    assignment: ASSIGNMENT,
    n: 3,
    privacy: "closed" as const,
    members: [
      { username: "alice", role: "maintainer" as const },
      { username: "bob", role: "member" as const },
    ],
    repo: "cs-fall-hw1-group-3",
    creatorLogin: "teacher",
  }

  it("runs the exact sequence: create, adds, attach, teacher drop, notifications PATCH", async () => {
    const { client, calls } = makeClient()
    const slug = await groupTeamName(CLASSROOM, ASSIGNMENT, 3)
    const result = await recoverGroupTeam(client, ORG, INPUT)
    expect(result.team).toEqual({ slug, id: 777, n: 3 })
    expect(result.warnings).toEqual([])
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST /orgs/${ORG}/teams`,
      `PUT /orgs/${ORG}/teams/${slug}/memberships/alice`,
      `PUT /orgs/${ORG}/teams/${slug}/memberships/bob`,
      `PUT /orgs/${ORG}/teams/${slug}/repos/${ORG}/cs-fall-hw1-group-3`,
      `DELETE /orgs/${ORG}/teams/${slug}/memberships/teacher`,
      `PATCH /orgs/${ORG}/teams/${slug}`,
    ])
    // Created silent; notifications re-enabled only AFTER the teacher drop.
    expect(calls[0].body).toMatchObject({
      notification_setting: "notifications_disabled",
    })
    expect(calls[1].body).toEqual({ role: "maintainer" })
    expect(calls[2].body).toEqual({ role: "member" })
    expect(calls[3].body).toEqual({ permission: "push" })
    expect(calls[5].body).toEqual({
      notification_setting: "notifications_enabled",
    })
  })

  it("a failed create aborts before any other step", async () => {
    const { client, calls } = makeClient({ failCreate: true })
    await expect(recoverGroupTeam(client, ORG, INPUT)).rejects.toMatchObject({
      status: 403,
    })
    expect(calls).toHaveLength(1)
  })

  it("collects per-step warnings without losing the created team", async () => {
    const { client, calls } = makeClient({
      failAddFor: new Set(["bob"]),
      failDrop: true,
    })
    const result = await recoverGroupTeam(client, ORG, INPUT)
    expect(result.warnings.map((w) => [w.step, w.username])).toEqual([
      ["addMember", "bob"],
      ["teacherDrop", undefined],
    ])
    // Every later step still ran: the attach and the notifications PATCH.
    expect(calls.some((call) => call.url.includes("/repos/"))).toBe(true)
    expect(calls.map((call) => call.method)).toContain("PATCH")
  })
})

describe("suggestMembersFromCommits", () => {
  const REPO = "cs-fall-hw1-group-3"

  function commit(author?: string | null, committer?: string | null) {
    return {
      author: author ? { login: author } : author,
      committer: committer ? { login: committer } : committer,
    }
  }

  function makeClient(pages: unknown[][]) {
    const urls: string[] = []
    const request = vi.fn(async (url: string) => {
      urls.push(url)
      const page = Number(new URLSearchParams(url.split("?")[1]).get("page"))
      return pages[page - 1] ?? []
    })
    return { client: { request } as unknown as GitHubClient, urls }
  }

  it("keeps first-seen roster committers, dropping bots and non-roster logins", async () => {
    const { client } = makeClient([
      [
        commit("Alice", "web-flow"),
        commit("github-actions[bot]", "github-actions"),
        commit("bob", "alice"), // alice again: deduped case-insensitively
        commit("mallory", "carol"), // mallory isn't on the roster
        commit(null, null), // unlinked author/committer
      ],
    ])
    const suggestions = await suggestMembersFromCommits(client, ORG, REPO, {
      rosterLogins: new Set(["alice", "bob", "carol"]),
    })
    expect(suggestions).toEqual(["Alice", "bob", "carol"])
  })

  it("caps the read at 3 pages of 100", async () => {
    const fullPage = Array.from({ length: 100 }, () => commit("alice", null))
    const { client, urls } = makeClient([fullPage, fullPage, fullPage])
    await suggestMembersFromCommits(client, ORG, REPO, {
      rosterLogins: new Set(["alice"]),
    })
    expect(urls).toEqual([
      `/repos/${ORG}/${REPO}/commits?per_page=100&page=1`,
      `/repos/${ORG}/${REPO}/commits?per_page=100&page=2`,
      `/repos/${ORG}/${REPO}/commits?per_page=100&page=3`,
    ])
  })

  it("stops after a short page", async () => {
    const { client, urls } = makeClient([[commit("alice", null)]])
    await suggestMembersFromCommits(client, ORG, REPO, {
      rosterLogins: new Set(["alice"]),
    })
    expect(urls).toHaveLength(1)
  })

  it("reads an empty repo (409) as no suggestions", async () => {
    const request = vi.fn(async () => {
      throw apiError(409, "Git Repository is empty.")
    })
    const client = { request } as unknown as GitHubClient
    await expect(
      suggestMembersFromCommits(client, ORG, REPO, {
        rosterLogins: new Set(["alice"]),
      }),
    ).resolves.toEqual([])
  })
})
