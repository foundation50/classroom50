import { describe, expect, it, vi } from "vitest"

import {
  assertClassroomNotArchived,
  createClassroomFiles,
  deleteClassroom,
} from "./classrooms"
import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"
import type { GitHubClient, GitHubRequestOptions } from "@/github-core/client"

// assertClassroomNotArchived is the authoritative write-path guard fanned out
// across ~11 assignment + roster mutations, so its branch matrix is
// behaviour-critical: archived => throw, legacy/missing (404) => allow,
// transient read failure => fail-closed with an actionable message (after one
// retry). It does I/O via getClassroomJson -> client.requestRaw, so we stub a
// minimal GitHubClient rather than the whole module.

const emptyRateLimit: GitHubRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const apiError = (status: number, rateLimit: Partial<GitHubRateLimit> = {}) =>
  new GitHubAPIError({
    status,
    url: "/repos/acme/classroom50/contents/cs101/classroom.json",
    message: `HTTP ${status}`,
    body: null,
    rateLimit: { ...emptyRateLimit, ...rateLimit },
  })

// A client whose requestRaw returns the given classroom.json body (as the
// serialized string getClassroomJson will JSON.parse).
const clientReturning = (body: unknown): GitHubClient => ({
  request: vi.fn(),
  requestRaw: vi.fn().mockResolvedValue(JSON.stringify(body)),
  fetchArchive: vi.fn(),
})

// A client whose requestRaw rejects on every call with the given error.
const clientRejecting = (err: unknown): GitHubClient => ({
  request: vi.fn(),
  requestRaw: vi.fn().mockRejectedValue(err),
  fetchArchive: vi.fn(),
})

describe("assertClassroomNotArchived", () => {
  it("throws when the classroom is archived (active: false)", async () => {
    const client = clientReturning({ short_name: "cs101", active: false })
    await expect(
      assertClassroomNotArchived(client, "acme", "cs101"),
    ).rejects.toThrow(/archived/i)
  })

  it("resolves when the classroom is active (active: true)", async () => {
    const client = clientReturning({ short_name: "cs101", active: true })
    await expect(
      assertClassroomNotArchived(client, "acme", "cs101"),
    ).resolves.toBeUndefined()
  })

  it("resolves for a legacy classroom with no active field", async () => {
    const client = clientReturning({ short_name: "cs101" })
    await expect(
      assertClassroomNotArchived(client, "acme", "cs101"),
    ).resolves.toBeUndefined()
  })

  it("fails OPEN on a 404 (missing/legacy classroom.json reads as active)", async () => {
    const client = clientRejecting(apiError(404))
    await expect(
      assertClassroomNotArchived(client, "acme", "cs101"),
    ).resolves.toBeUndefined()
    // A 404 is determinate, so it must not trigger the transient retry.
    expect(client.requestRaw).toHaveBeenCalledTimes(1)
  })

  it("fails CLOSED with an actionable message on a persistent 5xx (retried once)", async () => {
    const client = clientRejecting(apiError(503))
    await expect(
      assertClassroomNotArchived(client, "acme", "cs101"),
    ).rejects.toThrow(/couldn't verify/i)
    // One retry on a transient read => two attempts total.
    expect(client.requestRaw).toHaveBeenCalledTimes(2)
  })

  it("recovers when a transient 5xx succeeds on the retry", async () => {
    const requestRaw = vi
      .fn()
      .mockRejectedValueOnce(apiError(500))
      .mockResolvedValueOnce(
        JSON.stringify({ short_name: "cs101", active: true }),
      )
    const client: GitHubClient = {
      request: vi.fn(),
      requestRaw,
      fetchArchive: vi.fn(),
    }
    await expect(
      assertClassroomNotArchived(client, "acme", "cs101"),
    ).resolves.toBeUndefined()
    expect(requestRaw).toHaveBeenCalledTimes(2)
  })

  it("treats a rate-limit (429) as transient and fails closed after the retry", async () => {
    const client = clientRejecting(apiError(429))
    await expect(
      assertClassroomNotArchived(client, "acme", "cs101"),
    ).rejects.toThrow(/couldn't verify/i)
    expect(client.requestRaw).toHaveBeenCalledTimes(2)
  })
})

// createClassroomFiles provisions three secret teams (students, teacher, ta).
// GitHub auto-adds the authenticated creator as a maintainer of every team it
// creates, so the flow must drop the creator from the students + ta teams
// (leaving them only on teacher) — else the team-driven roster counts the
// owner as an enrolled student/TA. These tests route client.request by
// path+method, record the membership DELETEs, and assert exactly which teams the
// creator is removed from.
describe("createClassroomFiles creator team cleanup", () => {
  // A routing client that satisfies the whole create flow (team create + grant +
  // membership PUT/DELETE, then the git scaffolding calls). `onDelete` records
  // each membership DELETE; `deleteThrows` makes every DELETE reject so the
  // best-effort path can be exercised.
  const routingClient = (opts: {
    onDelete: (path: string) => void
    deleteThrows?: boolean
    // When true, the students-team create POST returns 422 so the flow adopts a
    // pre-existing team (created: false) instead of creating it.
    adoptStudentsTeam?: boolean
  }): GitHubClient => {
    const request = vi.fn(
      async (path: string, options?: GitHubRequestOptions) => {
        const method = options?.method ?? "GET"

        if (method === "DELETE" && path.includes("/memberships/")) {
          opts.onDelete(path)
          if (opts.deleteThrows) throw apiError(403)
          return undefined
        }
        // Adopt path: the students-team GET returns the pre-existing secret team.
        if (
          method === "GET" &&
          /\/orgs\/[^/]+\/teams\/classroom50-cs101$/.test(path)
        ) {
          return { id: 7, slug: "classroom50-cs101", privacy: "secret" }
        }
        // Team create/adopt -> { id, slug } derived from the POSTed name. When
        // adoptStudentsTeam is set, the students team POST 422s (already exists).
        if (method === "POST" && /\/orgs\/[^/]+\/teams$/.test(path)) {
          const name = (options?.body as { name?: string })?.name ?? "team"
          if (opts.adoptStudentsTeam && name === "classroom50-cs101") {
            throw apiError(422)
          }
          return { id: 1, slug: name }
        }
        // Config-repo read (getConfigRepoBranch).
        if (method === "GET" && /\/repos\/[^/]+\/classroom50$/.test(path)) {
          return { default_branch: "main" }
        }
        // Branch ref (getBranchRef).
        if (path.includes("/git/ref/heads/")) {
          return { object: { sha: "base-sha" } }
        }
        // Commit (getCommit).
        if (path.includes("/git/commits/")) {
          return { tree: { sha: "tree-sha" } }
        }
        // createTree.
        if (method === "POST" && path.endsWith("/git/trees")) {
          return { sha: "new-tree-sha" }
        }
        // createCommit.
        if (method === "POST" && path.endsWith("/git/commits")) {
          return { sha: "new-commit-sha" }
        }
        // updateRef.
        if (method === "PATCH" && path.includes("/git/refs/heads/")) {
          return { object: { sha: "new-commit-sha" } }
        }
        // Repo-grant PUT, teacher membership PUT, and anything else.
        return undefined
      },
    )
    return { request, requestRaw: vi.fn() } as unknown as GitHubClient
  }

  const input = {
    org: "acme",
    classroom: "cs101",
    term: "2026",
    creator: "prof",
  }

  it("removes the creator from the students, hta, and ta teams but never teacher", async () => {
    const deleted: string[] = []
    const client = routingClient({ onDelete: (p) => deleted.push(p) })

    await createClassroomFiles(client, input)

    expect(deleted).toContain(
      "/orgs/acme/teams/classroom50-cs101/memberships/prof",
    )
    expect(deleted).toContain(
      "/orgs/acme/teams/classroom50-cs101-hta/memberships/prof",
    )
    expect(deleted).toContain(
      "/orgs/acme/teams/classroom50-cs101-ta/memberships/prof",
    )
    expect(deleted).not.toContain(
      "/orgs/acme/teams/classroom50-cs101-teacher/memberships/prof",
    )
  })

  it("still completes when a creator-drop DELETE fails (best-effort)", async () => {
    const deleted: string[] = []
    const client = routingClient({
      onDelete: (p) => deleted.push(p),
      deleteThrows: true,
    })

    await expect(createClassroomFiles(client, input)).resolves.toMatchObject({
      newCommitSha: "new-commit-sha",
    })
    // All three non-teacher drops (students, hta, ta) were attempted even
    // though each threw.
    expect(deleted).toHaveLength(3)
  })

  it("does not attempt any creator drop when no creator is supplied", async () => {
    const deleted: string[] = []
    const client = routingClient({ onDelete: (p) => deleted.push(p) })

    await createClassroomFiles(client, { ...input, creator: undefined })

    expect(deleted).toHaveLength(0)
  })

  it("still drops the creator from an ADOPTED students team (mixed roles aren't allowed)", async () => {
    // The students team already exists (POST 422 -> adopt). Mixed roles are
    // disallowed, so the creator must be dropped regardless of whether we
    // created or adopted the team — the drop is intentionally not gated on the
    // created flag.
    const deleted: string[] = []
    const client = routingClient({
      onDelete: (p) => deleted.push(p),
      adoptStudentsTeam: true,
    })

    await createClassroomFiles(client, input)

    expect(deleted).toContain(
      "/orgs/acme/teams/classroom50-cs101/memberships/prof",
    )
    expect(deleted).toContain(
      "/orgs/acme/teams/classroom50-cs101-ta/memberships/prof",
    )
  })
})

// Deleting a classroom is the last moment its per-invite metadata teams are
// findable: they're recorded nowhere in the config repo, so once the classroom
// directory is gone nothing can enumerate them per-classroom again — and each
// holds an invited student's email address in its description.
describe("deleteClassroom invite-team purge", () => {
  const inviteSlug = "invite-0123456789abcdef"

  // A routing client covering the whole delete flow: classroom.json read, tree
  // read, commit/ref writes, then the org-teams listing + per-team read the
  // purge performs. Records every DELETE path.
  const deleteFlowClient = (opts: {
    onDelete: (path: string) => void
    inviteClassroom?: string
    listThrows?: boolean
  }): GitHubClient => {
    const request = vi.fn(
      async (path: string, options?: GitHubRequestOptions) => {
        const method = options?.method ?? "GET"

        if (method === "DELETE") {
          opts.onDelete(path)
          return undefined
        }
        if (method === "GET" && /\/repos\/[^/]+\/classroom50$/.test(path)) {
          return { default_branch: "main" }
        }
        if (path.includes("/git/ref/heads/")) {
          return { object: { sha: "base-sha" } }
        }
        if (path.includes("/git/commits/")) {
          return { tree: { sha: "tree-sha" }, sha: "base-sha" }
        }
        if (path.includes("/git/trees/")) {
          return {
            tree: [
              {
                path: "cs101/classroom.json",
                mode: "100644",
                type: "blob",
                sha: "a",
              },
            ],
            truncated: false,
          }
        }
        if (path.endsWith("/git/trees")) return { sha: "new-tree" }
        if (path.endsWith("/git/commits")) return { sha: "new-commit" }
        if (path.includes("/git/refs/heads/")) return {}
        // The purge's org-teams listing.
        if (/\/orgs\/[^/]+\/teams\?/.test(path)) {
          if (opts.listThrows) throw apiError(500)
          return [{ id: 9, slug: inviteSlug }]
        }
        // The purge's per-team read (description carries the claimed classroom).
        if (
          path.includes(`/teams/${inviteSlug}`) &&
          path.includes("/members")
        ) {
          return []
        }
        if (path.includes(`/teams/${inviteSlug}`)) {
          return {
            slug: inviteSlug,
            description: JSON.stringify({
              schema: "classroom50/invite/v1",
              email: "pending@x.edu",
              classroom: opts.inviteClassroom ?? "cs101",
            }),
          }
        }
        // Classroom team refs come from classroom.json (requestRaw below).
        return undefined
      },
    )
    return {
      request,
      requestRaw: vi.fn().mockResolvedValue(
        JSON.stringify({
          schema: "classroom50/classroom/v1",
          short_name: "cs101",
        }),
      ),
      fetchArchive: vi.fn(),
    } as unknown as GitHubClient
  }

  it("deletes the classroom's invite teams so no invited email is stranded", async () => {
    const deleted: string[] = []
    const client = deleteFlowClient({ onDelete: (p) => deleted.push(p) })

    const result = await deleteClassroom(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.deleted).toBe(true)
    expect(deleted).toContain(`/orgs/acme/teams/${inviteSlug}`)
    expect(result.teamDeleteWarning).toBeUndefined()
  })

  it("leaves another classroom's invite team alone", async () => {
    const deleted: string[] = []
    const client = deleteFlowClient({
      onDelete: (p) => deleted.push(p),
      inviteClassroom: "cs202",
    })

    await deleteClassroom(client, { org: "acme", classroom: "cs101" })
    // Nothing at all was deleted — the only team in the listing belongs to
    // another classroom (the test above is the positive control).
    expect(deleted).toEqual([])
  })

  it("warns that invitation records went unchecked when the listing fails", async () => {
    const deleted: string[] = []
    const client = deleteFlowClient({
      onDelete: (p) => deleted.push(p),
      listThrows: true,
    })

    const result = await deleteClassroom(client, {
      org: "acme",
      classroom: "cs101",
    })

    // The config deletion still succeeded, but the teacher must learn that a
    // stored email address may be left behind — this is the silent-failure case.
    expect(result.deleted).toBe(true)
    expect(result.teamDeleteWarning).toMatch(/invitation records/i)
    expect(result.teamDeleteWarning).toMatch(/email address/i)
  })
})
