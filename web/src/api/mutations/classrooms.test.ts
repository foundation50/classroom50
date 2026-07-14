import { describe, expect, it, vi } from "vitest"

import { assertClassroomNotArchived, createClassroomFiles } from "./classrooms"
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
})

// A client whose requestRaw rejects on every call with the given error.
const clientRejecting = (err: unknown): GitHubClient => ({
  request: vi.fn(),
  requestRaw: vi.fn().mockRejectedValue(err),
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
    const client: GitHubClient = { request: vi.fn(), requestRaw }
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

// createClassroomFiles provisions three secret teams (students, instructor, ta).
// GitHub auto-adds the authenticated creator as a maintainer of every team it
// creates, so the flow must drop the creator from the students + ta teams
// (leaving them only on instructor) — else the team-driven roster counts the
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
        // Repo-grant PUT, instructor membership PUT, and anything else.
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

  it("removes the creator from the students and ta teams but never instructor", async () => {
    const deleted: string[] = []
    const client = routingClient({ onDelete: (p) => deleted.push(p) })

    await createClassroomFiles(client, input)

    expect(deleted).toContain(
      "/orgs/acme/teams/classroom50-cs101/memberships/prof",
    )
    expect(deleted).toContain(
      "/orgs/acme/teams/classroom50-cs101-ta/memberships/prof",
    )
    expect(deleted).not.toContain(
      "/orgs/acme/teams/classroom50-cs101-instructor/memberships/prof",
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
    // Both drops were attempted even though each threw.
    expect(deleted).toHaveLength(2)
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
