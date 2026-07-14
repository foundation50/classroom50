import { describe, expect, it, vi } from "vitest"
import Papa from "papaparse"

import {
  enrollStudentInClassroom,
  inviteByEmail,
  bulkInviteByEmail,
  unenrollStudent,
  bulkUnenrollStudents,
  resolveClassroomPendingInvite,
  bulkEnrollStudentsInClassroom,
  assignRosterMemberRole,
  applyRosterRoleChange,
  inviteRosterStudents,
  syncRosterFromTeam,
  writeRosterRoles,
  migrateRosterFile,
  resolveTeamIdForRoleRead,
  updateStudent,
  updateStudentWithConflictRetry,
  parseStudentsCsv,
  parseRosterCsv,
  RosterCsvMalformedError,
  STUDENT_CSV_FIELDS,
  StudentAlreadyEnrolledError,
} from "./students"
import { GitHubAPIError } from "@/github-core/errors"
import type { GitHubClient } from "@/github-core/client"

// An already-org-member must land `enrolled` (not stuck "awaiting"), the per-row
// confirm must refuse a non-member, and an already-member email invite must
// resolve cross-roster or drop the stub. I/O is stubbed via a path-routing fake
// client; assertions read the roster.csv committed to git/trees.

type CommittedCsv = { content: string | null }

const makeClient = (opts: {
  startingCsv: string
  membershipState?: "active" | "pending" | null
  user?: {
    login: string
    id: number
    name?: string | null
    email?: string | null
  }
  // Pending invitations listed under the classroom team (drives the
  // sole-vs-multi-classroom cancel decision in bulk unenroll).
  teamInvites?: Array<{ id: number; login: string; team_count?: number }>
  onTree?: (
    tree: { path: string; sha?: string | null; content?: string }[],
  ) => void
}) => {
  const committed: CommittedCsv = { content: null }
  const membershipState = opts.membershipState ?? null
  const invitationDeletes: number[] = []

  const requestRaw = vi.fn().mockImplementation((path: string) => {
    if (path.includes("/contents/") && path.includes("classroom.json")) {
      return Promise.resolve(JSON.stringify({ short_name: "cs101" }))
    }
    return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
  })

  // getRawFile returns a base64 contents object via client.request.
  const csvFile = () => ({
    type: "file" as const,
    encoding: "base64" as const,
    content: Buffer.from(
      committed.content ?? opts.startingCsv,
      "utf-8",
    ).toString("base64"),
  })

  const request = vi
    .fn()
    .mockImplementation((path: string, options?: { body?: unknown }) => {
      if (/\/repos\/[^/]+\/classroom50$/.test(path))
        return { default_branch: "main" }
      if (path.includes("/contents/") && path.includes("roster.csv")) {
        return Promise.resolve(csvFile())
      }
      if (path.startsWith("/users/")) {
        const u = opts.user ?? { login: "alice", id: 42 }
        return Promise.resolve({ name: null, email: null, ...u })
      }
      if (path.includes("/memberships/") && !path.includes("/teams/")) {
        if (membershipState === null) {
          return Promise.reject(new Error("404 not a member"))
        }
        return Promise.resolve({ state: membershipState })
      }
      if (path.includes("/git/ref/heads/main") || path.includes("/git/ref/")) {
        return Promise.resolve({ object: { sha: "base-sha" } })
      }
      if (path.includes("/git/commits/")) {
        return Promise.resolve({ tree: { sha: "base-tree-sha" } })
      }
      if (path.endsWith("/git/trees")) {
        const tree = (
          options?.body as {
            tree?: { path: string; sha?: string | null; content?: string }[]
          }
        )?.tree
        if (tree) opts.onTree?.(tree)
        const csvEntry = tree?.find((t) => t.path.includes("roster.csv"))
        if (csvEntry?.content) committed.content = csvEntry.content
        return Promise.resolve({ sha: "tree-sha" })
      }
      if (path.endsWith("/git/commits")) {
        return Promise.resolve({ sha: "new-commit-sha" })
      }
      if (path.endsWith("/git/refs/heads/main")) {
        return Promise.resolve({})
      }
      // Team-scoped pending invitations (listTeamInvitations) — must return an
      // array and be matched before the generic /invitations catch-all below.
      if (path.includes("/teams/") && path.includes("/invitations")) {
        return Promise.resolve(opts.teamInvites ?? [])
      }
      // Cancel a specific invite by id.
      if (/\/invitations\/\d+$/.test(path)) {
        invitationDeletes.push(Number(path.split("/").pop()))
        return Promise.resolve({})
      }
      if (path.includes("/invitations")) {
        return Promise.resolve({})
      }
      if (path.includes("/teams/")) {
        return Promise.resolve({ state: "active" })
      }
      return Promise.reject(new Error(`unexpected request: ${path}`))
    })

  const client = { request, requestRaw } as unknown as GitHubClient
  return { client, committed, invitationDeletes }
}

const HEADER = "username,first_name,last_name,email,section,github_id,role\n"

// The web leg of the three-way roster header lockstep. The Go
// (TestFullRosterHeader) and Python (test_full_roster_header_matches_go_constant)
// suites each pin their own header constant to this exact string; the web app
// WRITES the file's column order (via STUDENT_CSV_FIELDS), so without this
// assertion a web-only reorder/rename would keep every web test green while the
// CLI's ParseRoster and the collector's read_students_csv reject every roster
// the web writes. Pin the source-of-truth constant, not a fixture.
describe("roster.csv header lockstep (web leg)", () => {
  it("STUDENT_CSV_FIELDS matches the Go/Python header verbatim", () => {
    expect(STUDENT_CSV_FIELDS.join(",")).toBe(
      "username,first_name,last_name,email,section,github_id,role",
    )
  })

  it("the fixture HEADER used by these tests is derived from the real constant", () => {
    expect(HEADER).toBe(STUDENT_CSV_FIELDS.join(",") + "\n")
  })
})

const rowsFromCsv = (csv: string) =>
  Papa.parse(csv, { header: true, skipEmptyLines: true }).data as Record<
    string,
    string
  >[]

describe("roster write target — commits roster.csv, never students.csv", () => {
  // When roster.csv already exists, the write targets roster.csv and never
  // touches the legacy students.csv (no stray upsert or deletion entry). The
  // legacy-fallback + migrate-on-write case is covered separately below.
  it("writes the roster blob at roster.csv and leaves students.csv untouched", async () => {
    const treePaths: string[] = []
    const { client } = makeClient({
      startingCsv: HEADER,
      membershipState: "active",
      user: { login: "alice", id: 42 },
      onTree: (tree) => {
        for (const t of tree) treePaths.push(t.path)
      },
    })

    await enrollStudentInClassroom(client, {
      org: "acme",
      classroom: "cs101",
      username: "alice",
    })

    expect(treePaths).toContain("cs101/roster.csv")
    expect(treePaths).not.toContain("cs101/students.csv")
  })

  // A classroom bootstrapped before the roster rename has only the legacy file
  // on disk. The read-modify-write mutations must fall back to it on a
  // roster.csv 404 (mirroring the display readers) so the roster stays editable
  // from the web before `gh teacher roster migrate` runs; the write converges
  // onto roster.csv AND deletes the legacy file in the same commit
  // (migrate-on-write), so a first edit renames it.
  it("reads the legacy students.csv when roster.csv is absent, writing roster.csv and deleting students.csv", async () => {
    const treeEntries: {
      path: string
      sha?: string | null
      content?: string
    }[] = []
    const requestRaw = vi.fn().mockImplementation((path: string) => {
      if (path.includes("/contents/") && path.includes("classroom.json")) {
        return Promise.resolve(JSON.stringify({ short_name: "cs101" }))
      }
      return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
    })
    const request = vi
      .fn()
      .mockImplementation((path: string, options?: { body?: unknown }) => {
        if (/\/repos\/[^/]+\/classroom50$/.test(path))
          return { default_branch: "main" }
        // Un-migrated classroom: roster.csv 404s, only students.csv exists.
        if (path.includes("/contents/") && path.includes("roster.csv")) {
          return Promise.reject(
            new GitHubAPIError({
              status: 404,
              url: path,
              message: "not found",
              body: null,
              rateLimit: {
                limit: null,
                remaining: null,
                used: null,
                reset: null,
                resource: null,
                retryAfter: null,
              },
            }),
          )
        }
        if (path.includes("/contents/") && path.includes("students.csv")) {
          return Promise.resolve({
            type: "file",
            encoding: "base64",
            content: Buffer.from(HEADER, "utf-8").toString("base64"),
          })
        }
        if (path.startsWith("/users/")) {
          return Promise.resolve({ login: "alice", id: 42, name: null })
        }
        if (path.includes("/memberships/") && !path.includes("/teams/")) {
          return Promise.reject(new Error("404 not a member"))
        }
        if (path.includes("/git/ref/")) {
          return Promise.resolve({ object: { sha: "base-sha" } })
        }
        if (path.includes("/git/commits/")) {
          return Promise.resolve({ tree: { sha: "base-tree-sha" } })
        }
        // Recursive tree read used by getRawFileWithFallbackSource to resolve
        // legacy-vs-lag: this un-migrated classroom has students.csv only.
        if (path.includes("/git/trees/") && path.includes("recursive=1")) {
          return Promise.resolve({
            tree: [{ path: "cs101/students.csv", type: "blob" }],
            truncated: false,
          })
        }
        if (path.endsWith("/git/trees")) {
          const tree = (
            options?.body as {
              tree?: { path: string; sha?: string | null; content?: string }[]
            }
          )?.tree
          for (const t of tree ?? []) treeEntries.push(t)
          return Promise.resolve({ sha: "tree-sha" })
        }
        if (path.endsWith("/git/commits")) {
          return Promise.resolve({ sha: "new-commit-sha" })
        }
        if (path.endsWith("/git/refs/heads/main")) {
          return Promise.resolve({})
        }
        if (path.includes("/teams/")) {
          return Promise.resolve({ state: "active" })
        }
        return Promise.reject(new Error(`unexpected request: ${path}`))
      })
    const client = { request, requestRaw } as unknown as GitHubClient

    // Must NOT throw — the legacy read fallback keeps the mutation working.
    await enrollStudentInClassroom(client, {
      org: "acme",
      classroom: "cs101",
      username: "alice",
    })

    // The write converges onto roster.csv (content upsert)...
    const rosterUpsert = treeEntries.find(
      (t) => t.path === "cs101/roster.csv" && t.content !== undefined,
    )
    expect(rosterUpsert).toBeTruthy()
    // ...and deletes the legacy students.csv in the same commit (sha: null).
    const legacyDelete = treeEntries.find(
      (t) => t.path === "cs101/students.csv" && t.sha === null,
    )
    expect(legacyDelete).toBeTruthy()
  })

  // Regression guard for the stale-read data-loss hazard: the Contents API can
  // 404 roster.csv at a pinned commit due to per-path lag while the deleted
  // legacy students.csv is still served stale. The delete + overwrite must NOT
  // be driven by that 404 — getRawFileWithFallbackSource consults the git tree
  // (consistent at a commit) and, seeing roster.csv present, re-reads it and
  // reports fromLegacy=false, so no students.csv deletion and no stale
  // overwrite are committed.
  it("does not migrate when roster.csv 404s from lag but the tree shows it present", async () => {
    const treeEntries: {
      path: string
      sha?: string | null
      content?: string
    }[] = []
    let rosterContentsReads = 0
    const requestRaw = vi.fn().mockImplementation((path: string) => {
      if (path.includes("/contents/") && path.includes("classroom.json")) {
        return Promise.resolve(JSON.stringify({ short_name: "cs101" }))
      }
      return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
    })
    const notFound = (path: string) =>
      new GitHubAPIError({
        status: 404,
        url: path,
        message: "not found",
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
    const request = vi
      .fn()
      .mockImplementation((path: string, options?: { body?: unknown }) => {
        if (/\/repos\/[^/]+\/classroom50$/.test(path))
          return { default_branch: "main" }
        if (path.includes("/contents/") && path.includes("roster.csv")) {
          rosterContentsReads++
          // First read 404s (lag); the tree-confirmed re-read succeeds.
          if (rosterContentsReads === 1) return Promise.reject(notFound(path))
          return Promise.resolve({
            type: "file",
            encoding: "base64",
            content: Buffer.from(HEADER, "utf-8").toString("base64"),
          })
        }
        // The stale legacy blob is still served — but must NOT be trusted.
        if (path.includes("/contents/") && path.includes("students.csv")) {
          return Promise.resolve({
            type: "file",
            encoding: "base64",
            content: Buffer.from(HEADER + "ghost,,,,,999\n", "utf-8").toString(
              "base64",
            ),
          })
        }
        if (path.startsWith("/users/")) {
          return Promise.resolve({ login: "alice", id: 42, name: null })
        }
        if (path.includes("/memberships/") && !path.includes("/teams/")) {
          return Promise.reject(new Error("404 not a member"))
        }
        if (path.includes("/git/ref/")) {
          return Promise.resolve({ object: { sha: "base-sha" } })
        }
        if (path.includes("/git/commits/")) {
          return Promise.resolve({ tree: { sha: "base-tree-sha" } })
        }
        // Tree is authoritative: roster.csv IS present (the 404 was lag).
        if (path.includes("/git/trees/") && path.includes("recursive=1")) {
          return Promise.resolve({
            tree: [
              { path: "cs101/roster.csv", type: "blob" },
              { path: "cs101/students.csv", type: "blob" },
            ],
            truncated: false,
          })
        }
        if (path.endsWith("/git/trees")) {
          const tree = (options?.body as { tree?: typeof treeEntries })?.tree
          for (const t of tree ?? []) treeEntries.push(t)
          return Promise.resolve({ sha: "tree-sha" })
        }
        if (path.endsWith("/git/commits")) {
          return Promise.resolve({ sha: "new-commit-sha" })
        }
        if (path.endsWith("/git/refs/heads/main")) {
          return Promise.resolve({})
        }
        if (path.includes("/teams/")) {
          return Promise.resolve({ state: "active" })
        }
        return Promise.reject(new Error(`unexpected request: ${path}`))
      })
    const client = { request, requestRaw } as unknown as GitHubClient

    await enrollStudentInClassroom(client, {
      org: "acme",
      classroom: "cs101",
      username: "alice",
    })

    // No students.csv deletion — the tree said roster.csv exists.
    expect(treeEntries.some((t) => t.path === "cs101/students.csv")).toBe(false)
    // The write used the (re-read) roster.csv content, not the stale legacy
    // blob: the fabricated `ghost` row from students.csv must not appear.
    const rosterUpsert = treeEntries.find((t) => t.path === "cs101/roster.csv")
    expect(rosterUpsert?.content).not.toContain("ghost")
  })
})

describe("enrollStudentInClassroom — already-member writes the row directly", () => {
  it("writes the student row when the user is already an active org member", async () => {
    const { client, committed } = makeClient({
      startingCsv: HEADER,
      membershipState: "active",
      user: { login: "alice", id: 42 },
    })

    await enrollStudentInClassroom(client, {
      org: "acme",
      classroom: "cs101",
      username: "alice",
    })

    const rows = rowsFromCsv(committed.content!)
    const alice = rows.find((r) => r.username === "alice")
    expect(alice?.github_id).toBe("42")
  })

  it("writes the row when the user is not yet a member", async () => {
    const { client, committed } = makeClient({
      startingCsv: HEADER,
      membershipState: null,
      user: { login: "bob", id: 43 },
    })

    await enrollStudentInClassroom(client, {
      org: "acme",
      classroom: "cs101",
      username: "bob",
    })

    const rows = rowsFromCsv(committed.content!)
    const bob = rows.find((r) => r.username === "bob")
    expect(bob?.github_id).toBe("43")
  })

  it("throws StudentAlreadyEnrolledError when the login is already on the roster", async () => {
    const { client } = makeClient({
      startingCsv: `${HEADER}alice,,,,,42\n`,
      membershipState: "active",
      user: { login: "alice", id: 42 },
    })

    await expect(
      enrollStudentInClassroom(client, {
        org: "acme",
        classroom: "cs101",
        username: "alice",
      }),
    ).rejects.toBeInstanceOf(StudentAlreadyEnrolledError)
  })

  it("throws StudentAlreadyEnrolledError when the github_id matches a renamed login", async () => {
    // The CSV stores a stale login but the same github_id; the current account
    // resolves to a different login. Dedupe by id must still catch it.
    const { client } = makeClient({
      startingCsv: `${HEADER}old-alice,,,,,42\n`,
      membershipState: "active",
      user: { login: "new-alice", id: 42 },
    })

    await expect(
      enrollStudentInClassroom(client, {
        org: "acme",
        classroom: "cs101",
        username: "new-alice",
      }),
    ).rejects.toMatchObject({ login: "new-alice" })
  })
})

describe("inviteByEmail — org invite only, no CSV write", () => {
  const apiError422 = () =>
    new GitHubAPIError({
      status: 422,
      url: "/orgs/acme/invitations",
      message: "Validation Failed: already a member",
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

  // inviteSucceeds=false makes POST /invitations 422 (the already-member
  // signal). Records whether any git tree write (a CSV commit) happened so we
  // can assert email invites never touch roster.csv.
  const makeEmailClient = (opts: {
    inviteSucceeds: boolean
    noTeamBlock?: boolean
  }) => {
    const state = {
      csvWritten: false,
      inviteAttempted: false,
      inviteBody: null as unknown,
    }

    const requestRaw = vi.fn().mockImplementation((path: string) => {
      if (path.includes("classroom.json")) {
        const meta: Record<string, unknown> = { short_name: "x" }
        if (!opts.noTeamBlock) meta.team = { slug: "classroom50-x", id: 4242 }
        return Promise.resolve(JSON.stringify(meta))
      }
      return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
    })

    const request = vi
      .fn()
      .mockImplementation((path: string, options?: { body?: unknown }) => {
        if (/\/repos\/[^/]+\/classroom50$/.test(path))
          return { default_branch: "main" }
        if (path.endsWith("/git/trees")) {
          state.csvWritten = true
          return Promise.resolve({ sha: "tree-sha" })
        }
        if (path.endsWith("/invitations")) {
          state.inviteAttempted = true
          if (opts.inviteSucceeds) {
            state.inviteBody = options?.body
            return Promise.resolve({})
          }
          return Promise.reject(apiError422())
        }
        return Promise.reject(new Error(`unexpected request: ${path}`))
      })

    return {
      client: { request, requestRaw } as unknown as GitHubClient,
      state,
    }
  }

  it("sends the org invite (with team) and writes NO roster.csv row", async () => {
    const { client, state } = makeEmailClient({ inviteSucceeds: true })

    const result = await inviteByEmail(client, {
      org: "acme",
      classroom: "cs101",
      email: "new@x.edu",
    })

    expect(result.inviteWarning).toBeUndefined()
    expect(state.csvWritten).toBe(false)
    // The classroom team id is attached so acceptance activates team membership.
    expect(state.inviteBody).toMatchObject({
      email: "new@x.edu",
      team_ids: [4242],
    })
  })

  it("blocks the invite (throws) when the classroom team can't be resolved", async () => {
    // Team-authoritative model: an invite that can't carry the team is broken
    // (accepted student would be an org member with no team and no CSV row,
    // silently uncollected), so we send nothing and fail loudly instead.
    const { client, state } = makeEmailClient({
      inviteSucceeds: true,
      noTeamBlock: true,
    })

    await expect(
      inviteByEmail(client, {
        org: "acme",
        classroom: "cs101",
        email: "noteam@x.edu",
      }),
    ).rejects.toThrow(/couldn't resolve the classroom team/i)

    // Nothing was sent and nothing was written.
    expect(state.inviteAttempted).toBe(false)
    expect(state.csvWritten).toBe(false)
  })

  it("422 already-member -> warns to add by username, writes no row", async () => {
    const { client, state } = makeEmailClient({ inviteSucceeds: false })

    const result = await inviteByEmail(client, {
      org: "acme",
      classroom: "cs101",
      email: "member@x.edu",
    })

    expect(result.inviteWarning).toMatch(/already belongs to a member/i)
    expect(result.inviteWarning).toMatch(/by github username/i)
    expect(state.csvWritten).toBe(false)
  })
})

describe("bulkInviteByEmail — bulk org invites by email, no CSV write", () => {
  const apiError = (status: number, message: string) =>
    new GitHubAPIError({
      status,
      url: "/orgs/acme/invitations",
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

  // A 429 that carries a Retry-After (seconds), so a retry test can assert the
  // honored delay was slept.
  const rateLimitWithRetryAfter = (seconds: number) =>
    new GitHubAPIError({
      status: 429,
      url: "/orgs/acme/invitations",
      message: "secondary rate limit",
      body: null,
      rateLimit: {
        limit: null,
        remaining: null,
        used: null,
        reset: null,
        resource: null,
        retryAfter: seconds,
      },
    })

  // Records every invite body and whether any git tree write happened. Can 422
  // a specific email (already-member), reject one with a 429 (rate limit), or
  // reject one with a generic 500 (failed) so every result bucket is testable.
  const makeClient = (opts?: {
    memberEmails?: string[]
    noTeam?: boolean
    rateLimitEmails?: string[]
    failEmails?: string[]
    // 429 (with Retry-After) the first N POST /invitations attempts, then let
    // later attempts through — exercises the Retry-After-backed retry pass.
    rateLimitFirstN?: number
  }) => {
    const memberEmails = new Set(opts?.memberEmails ?? [])
    const rateLimitEmails = new Set(opts?.rateLimitEmails ?? [])
    const failEmails = new Set(opts?.failEmails ?? [])
    let inviteAttempts = 0
    const state = {
      csvWritten: false,
      inviteBodies: [] as {
        email: string
        role: string
        team_ids?: number[]
      }[],
    }

    const requestRaw = vi.fn().mockImplementation((path: string) => {
      if (path.includes("classroom.json")) {
        const meta: Record<string, unknown> = { short_name: "x" }
        if (!opts?.noTeam) meta.team = { slug: "classroom50-x", id: 4242 }
        return Promise.resolve(JSON.stringify(meta))
      }
      return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
    })

    const request = vi
      .fn()
      .mockImplementation(
        (path: string, options?: { body?: unknown; method?: string }) => {
          if (/\/repos\/[^/]+\/classroom50$/.test(path))
            return { default_branch: "main" }
          if (path.endsWith("/git/trees")) {
            state.csvWritten = true
            return Promise.resolve({ sha: "tree-sha" })
          }
          // Staff-team ensure (instructor/ta role -> resolveTeamIdByRole): create
          // returns a fresh team; the config-repo write grant is a no-op PUT.
          if (path.endsWith("/teams") && options?.method === "POST") {
            const body = (options as { body?: { name?: string } }).body
            return Promise.resolve({
              id: 5000,
              slug: body?.name ?? "team",
              privacy: "secret",
            })
          }
          if (path.includes("/teams/") && path.includes("/repos/")) {
            return Promise.resolve({})
          }
          if (path.endsWith("/invitations")) {
            const body = options?.body as {
              email: string
              role: string
              team_ids?: number[]
            }
            const attempt = inviteAttempts++
            if (
              opts?.rateLimitFirstN !== undefined &&
              attempt < opts.rateLimitFirstN
            ) {
              return Promise.reject(rateLimitWithRetryAfter(60))
            }
            if (memberEmails.has(body.email)) {
              return Promise.reject(apiError(422, "already a member"))
            }
            if (rateLimitEmails.has(body.email)) {
              return Promise.reject(apiError(429, "rate limited"))
            }
            if (failEmails.has(body.email)) {
              return Promise.reject(apiError(500, "server error"))
            }
            state.inviteBodies.push(body)
            return Promise.resolve({})
          }
          return Promise.reject(new Error(`unexpected request: ${path}`))
        },
      )

    return { client: { request, requestRaw } as unknown as GitHubClient, state }
  }

  it("invites every email with the classroom team and writes NO roster.csv", async () => {
    const { client, state } = makeClient()

    const result = await bulkInviteByEmail(client, {
      org: "acme",
      classroom: "cs101",
      invites: [{ email: "a@x.edu" }, { email: "b@x.edu", role: "student" }],
    })

    expect(result.invited.map((i) => i.email).sort()).toEqual([
      "a@x.edu",
      "b@x.edu",
    ])
    expect(result.skipped).toEqual([])
    expect(result.failed).toEqual([])
    expect(state.csvWritten).toBe(false)
    // Every invite carried the classroom team as a plain member (default role).
    for (const body of state.inviteBodies) {
      expect(body.team_ids).toEqual([4242])
      expect(body.role).toBe("direct_member")
    }
  })

  it("invites an instructor as an org OWNER (admin role)", async () => {
    const { client, state } = makeClient()

    await bulkInviteByEmail(client, {
      org: "acme",
      classroom: "cs101",
      invites: [{ email: "prof@x.edu", role: "instructor" }],
    })

    expect(state.inviteBodies[0]).toMatchObject({
      email: "prof@x.edu",
      role: "admin",
    })
  })

  it("routes a 422 already-member into skipped, not failed", async () => {
    const { client } = makeClient({ memberEmails: ["member@x.edu"] })

    const result = await bulkInviteByEmail(client, {
      org: "acme",
      classroom: "cs101",
      invites: [{ email: "member@x.edu" }, { email: "fresh@x.edu" }],
    })

    expect(result.skipped).toEqual([{ email: "member@x.edu" }])
    expect(result.invited.map((i) => i.email)).toEqual(["fresh@x.edu"])
    expect(result.failed).toEqual([])
  })

  it("reports progress and returns early for an empty invite list", async () => {
    const { client, state } = makeClient()
    const result = await bulkInviteByEmail(client, {
      org: "acme",
      classroom: "cs101",
      invites: [],
    })
    expect(result).toEqual({
      invited: [],
      skipped: [],
      failed: [],
      deferred: [],
    })
    expect(state.inviteBodies).toEqual([])
  })

  it("blocks the whole batch (throws, sends nothing) when the classroom team can't be resolved", async () => {
    // A team-less email invite would orphan the invitee (no team, no CSV row),
    // so the batch must fail loudly before sending anything — mirroring the
    // single inviteByEmail guard.
    const { client, state } = makeClient({ noTeam: true })

    await expect(
      bulkInviteByEmail(client, {
        org: "acme",
        classroom: "cs101",
        invites: [{ email: "a@x.edu" }, { email: "b@x.edu" }],
      }),
    ).rejects.toThrow(/couldn't resolve the classroom team/i)

    expect(state.inviteBodies).toEqual([])
    expect(state.csvWritten).toBe(false)
  })

  it("routes a non-422, non-rate-limit error into failed (not skipped)", async () => {
    // A 500 (or any non-422/non-throttle error) must land in `failed` with its
    // message surfaced, while the rest of the batch still invites.
    const { client } = makeClient({ failEmails: ["broken@x.edu"] })

    const result = await bulkInviteByEmail(client, {
      org: "acme",
      classroom: "cs101",
      invites: [{ email: "broken@x.edu" }, { email: "ok@x.edu" }],
    })

    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].email).toBe("broken@x.edu")
    expect(result.failed[0].message).toMatch(/server error/i)
    expect(result.invited.map((i) => i.email)).toEqual(["ok@x.edu"])
    expect(result.skipped).toEqual([])
    expect(result.deferred).toEqual([])
  })

  it("defers the rest once a mid-batch rate limit hits, sending no new invites", async () => {
    // More targets than REPO_READ_CONCURRENCY (=8): once the throttled invite
    // sets the rateLimited flag, every not-yet-started target short-circuits to
    // `deferred` (never `failed`), and no invite body is recorded for them.
    const total = 20
    const targets = Array.from({ length: total }, (_, i) => ({
      email: `u${i}@x.edu`,
    }))
    // Throttle the very first target so the flag flips as early as possible.
    const { client, state } = makeClient({ rateLimitEmails: ["u0@x.edu"] })

    const result = await bulkInviteByEmail(client, {
      org: "acme",
      classroom: "cs101",
      invites: targets,
      // Isolate the mid-batch short-circuit from the Retry-After retry pass.
      maxRetries: 0,
    })

    // The throttled email is deferred; nothing is misrouted to `failed`.
    expect(result.deferred).toContain("u0@x.edu")
    expect(result.failed).toEqual([])
    // Every target is accounted for exactly once across the buckets.
    expect(
      result.invited.length +
        result.skipped.length +
        result.failed.length +
        result.deferred.length,
    ).toBe(total)
    // The short-circuit actually fired: with the flag set early, most targets
    // are deferred rather than sent (bounded by the concurrency window that was
    // already in flight when the flag flipped).
    expect(result.deferred.length).toBeGreaterThan(total / 2)
    // No invite was sent for a deferred email.
    const sentEmails = new Set(state.inviteBodies.map((b) => b.email))
    for (const email of result.deferred) {
      expect(sentEmails.has(email)).toBe(false)
    }
  })

  it("auto-retries a deferred email honoring Retry-After, moving it to invited", async () => {
    // The first POST 429s (with Retry-After 60s), deferring the email; the retry
    // pass sleeps the honored delay and re-attempts, which succeeds. Injected
    // sleepFn keeps the test instant and records the honored delay.
    const { client, state } = makeClient({ rateLimitFirstN: 1 })
    const slept: number[] = []

    const result = await bulkInviteByEmail(client, {
      org: "acme",
      classroom: "cs101",
      invites: [{ email: "a@x.edu" }],
      sleepFn: async (ms) => {
        slept.push(ms)
      },
    })

    expect(result.invited.map((i) => i.email)).toEqual(["a@x.edu"])
    expect(result.deferred).toEqual([])
    expect(result.failed).toEqual([])
    // Honored the 60s Retry-After from the rate-limit error.
    expect(slept.some((ms) => ms >= 60_000)).toBe(true)
    expect(state.inviteBodies).toHaveLength(1)
  })

  it("leaves an email deferred when the retry cap is exhausted", async () => {
    // Throttled on every attempt; with maxRetries: 1 the single retry round also
    // 429s, so the email ends in `deferred` (never failed), sent zero times.
    const { client, state } = makeClient({ rateLimitEmails: ["a@x.edu"] })
    const slept: number[] = []

    const result = await bulkInviteByEmail(client, {
      org: "acme",
      classroom: "cs101",
      invites: [{ email: "a@x.edu" }],
      maxRetries: 1,
      sleepFn: async (ms) => {
        slept.push(ms)
      },
    })

    expect(result.deferred).toEqual(["a@x.edu"])
    expect(result.failed).toEqual([])
    expect(result.invited).toEqual([])
    // One retry round ran (one sleep), then the cap was hit.
    expect(slept).toHaveLength(1)
    expect(state.inviteBodies).toHaveLength(0)
  })

  it("routes a non-rate-limit error during a retry round to failed", async () => {
    // First attempt 429s (deferred); the retry attempt hits a 500 -> failed, not
    // stuck in deferred.
    let attempt = 0
    const { client } = makeClient()
    // Re-wrap the client's request so the SAME email 429s once then 500s.
    const inner = client.request as unknown as (
      p: string,
      o?: { method?: string; body?: unknown },
    ) => Promise<unknown>
    const request = vi
      .fn()
      .mockImplementation((path: string, options?: { method?: string }) => {
        if (path.endsWith("/invitations")) {
          const n = attempt++
          if (n === 0) return Promise.reject(rateLimitWithRetryAfter(1))
          return Promise.reject(apiError(500, "server error"))
        }
        return inner(path, options)
      })
    const wrapped = { ...client, request } as unknown as GitHubClient

    const result = await bulkInviteByEmail(wrapped, {
      org: "acme",
      classroom: "cs101",
      invites: [{ email: "a@x.edu" }],
      sleepFn: async () => {},
    })

    expect(result.failed).toEqual([
      { email: "a@x.edu", message: expect.stringContaining("server error") },
    ])
    expect(result.deferred).toEqual([])
    expect(result.invited).toEqual([])
  })

  it("maps a mixed-role batch to the right team and org role per email", async () => {
    // student/ta -> plain member on their team; instructor -> org OWNER (admin).
    // Asserts role AND team_ids together so a role/team cross-wiring is caught.
    const { client, state } = makeClient()

    await bulkInviteByEmail(client, {
      org: "acme",
      classroom: "cs101",
      invites: [
        { email: "stu@x.edu", role: "student" },
        { email: "ta@x.edu", role: "ta" },
        { email: "prof@x.edu", role: "instructor" },
      ],
    })

    const byEmail = new Map(state.inviteBodies.map((b) => [b.email, b]))
    // Student rides the classroom team (id 4242) as a plain member.
    expect(byEmail.get("stu@x.edu")).toMatchObject({
      role: "direct_member",
      team_ids: [4242],
    })
    // TA rides the ensured staff team (id 5000) as a plain member.
    expect(byEmail.get("ta@x.edu")).toMatchObject({
      role: "direct_member",
      team_ids: [5000],
    })
    // Instructor becomes an org OWNER on the ensured staff team.
    expect(byEmail.get("prof@x.edu")).toMatchObject({
      role: "admin",
      team_ids: [5000],
    })
  })
})

describe("updateStudent — edit a roster row's teacher-facing fields in place", () => {
  // alice: enrolled github row (identity by github_id 42); bob: email-only.
  const aliceRow = "alice,Alice,A,alice@x.edu,Period 1,42\n"
  const bobRow = ",Bob,B,bob@x.edu,,\n"

  it("rewrites only first/last/section and preserves identity columns", async () => {
    const { client, committed } = makeClient({ startingCsv: HEADER + aliceRow })

    await updateStudent(client, {
      org: "acme",
      classroom: "cs101",
      key: "42",
      patch: {
        first_name: "Alicia",
        last_name: "Anderson",
        email: "alice@x.edu", // unchanged
        section: "Period 2",
      },
    })

    const alice = rowsFromCsv(committed.content!).find(
      (r) => r.github_id === "42",
    )
    expect(alice?.first_name).toBe("Alicia")
    expect(alice?.last_name).toBe("Anderson")
    expect(alice?.section).toBe("Period 2")
    // identity preserved verbatim
    expect(alice?.username).toBe("alice")
    expect(alice?.github_id).toBe("42")
  })

  it("throws and does not write when no row matches the key", async () => {
    const { client, committed } = makeClient({ startingCsv: HEADER + aliceRow })

    await expect(
      updateStudent(client, {
        org: "acme",
        classroom: "cs101",
        key: "999",
        patch: { first_name: "X", last_name: "Y", email: "", section: "" },
      }),
    ).rejects.toThrow(/does not exist in roster/i)
    expect(committed.content).toBeNull()
  })

  it("upserts a new row when no row matches but identity is provided", async () => {
    // A team member (e.g. a staff instructor) with no roster.csv row yet: editing
    // their profile should CREATE the row from identity rather than throw.
    const { client, committed } = makeClient({ startingCsv: HEADER + aliceRow })

    const result = await updateStudent(client, {
      org: "acme",
      classroom: "cs101",
      key: "77",
      patch: {
        first_name: "Sam",
        last_name: "Staff",
        email: "sam@x.edu",
        section: "",
      },
      identity: { github_id: "77", username: "sam" },
    })

    const rows = rowsFromCsv(committed.content!)
    // Existing alice row is preserved; the new sam row is appended with identity.
    expect(rows.find((r) => r.github_id === "42")?.username).toBe("alice")
    const sam = rows.find((r) => r.github_id === "77")
    expect(sam).toMatchObject({
      github_id: "77",
      username: "sam",
      first_name: "Sam",
      last_name: "Staff",
      email: "sam@x.edu",
    })
    expect(result.student.github_id).toBe("77")
  })

  it("updates a username-only row (no duplicate) when editing keyed by github_id", async () => {
    // A legacy username-only row for "carol"; the edit is keyed by github_id (as
    // buildTeamRoster stamps an enrolled row's id from the live member). The
    // upsert must match by the identity claim (username) and UPDATE that row,
    // not append a second row for the same person.
    const carolRow = "carol,,,,,\n" // username only, no github_id
    const { client, committed } = makeClient({
      startingCsv: HEADER + aliceRow + carolRow,
    })

    await updateStudent(client, {
      org: "acme",
      classroom: "cs101",
      key: "88", // github_id key, which does NOT match the id-less carol row
      patch: {
        first_name: "Carol",
        last_name: "C",
        email: "carol@x.edu",
        section: "Period 3",
      },
      identity: { github_id: "88", username: "carol" },
    })

    const rows = rowsFromCsv(committed.content!)
    // Exactly one carol row (updated in place), not a duplicate.
    const carols = rows.filter((r) => r.username === "carol")
    expect(carols).toHaveLength(1)
    expect(carols[0]).toMatchObject({
      first_name: "Carol",
      email: "carol@x.edu",
    })
    // Total rows unchanged (alice + carol), no append.
    expect(rows).toHaveLength(2)
  })

  it("blocks editing into another row's email and leaves the CSV unwritten", async () => {
    const { client, committed } = makeClient({
      startingCsv: HEADER + aliceRow + bobRow,
    })

    await expect(
      updateStudent(client, {
        org: "acme",
        classroom: "cs101",
        key: "42", // alice
        patch: {
          first_name: "Alice",
          last_name: "A",
          email: "BOB@x.edu", // case-insensitively collides with bob
          section: "Period 1",
        },
      }),
    ).rejects.toThrow(/already used by another student/i)
    expect(committed.content).toBeNull()
  })

  it("allows keeping the row's own email (case-insensitive, not a false duplicate)", async () => {
    const { client, committed } = makeClient({
      startingCsv: HEADER + aliceRow + bobRow,
    })

    await updateStudent(client, {
      org: "acme",
      classroom: "cs101",
      key: "42",
      patch: {
        first_name: "Alice",
        last_name: "A",
        email: "ALICE@x.edu", // same address, different case
        section: "Period 1",
      },
    })

    const rows = rowsFromCsv(committed.content!)
    expect(rows.find((r) => r.github_id === "42")?.email).toBe("ALICE@x.edu")
    // bob untouched and still present
    expect(
      rows.find((r) => r.username === "" && r.first_name === "Bob"),
    ).toBeTruthy()
    expect(rows).toHaveLength(2)
  })

  it("rejects an edit on an archived classroom before any commit", async () => {
    const committed: { content: string | null } = { content: null }
    const requestRaw = vi.fn().mockImplementation((path: string) => {
      if (path.includes("/contents/") && path.includes("classroom.json")) {
        // archived -> active:false
        return Promise.resolve(
          JSON.stringify({ short_name: "cs101", active: false }),
        )
      }
      return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
    })
    const request = vi.fn().mockImplementation((path: string) => {
      if (/\/repos\/[^/]+\/classroom50$/.test(path))
        return { default_branch: "main" }
      if (path.includes("/git/trees")) {
        committed.content = "should-not-write"
      }
      return Promise.reject(new Error(`unexpected request: ${path}`))
    })
    const client = { request, requestRaw } as unknown as GitHubClient

    await expect(
      updateStudent(client, {
        org: "acme",
        classroom: "cs101",
        key: "42",
        patch: { first_name: "X", last_name: "Y", email: "", section: "" },
      }),
    ).rejects.toThrow(/archived/i)
    expect(committed.content).toBeNull()
  })

  it("allows editing name/section (email unchanged) on an unenrolled row", async () => {
    const daveRow = "dave,Dave,D,dave@x.edu,,77\n"
    const { client, committed } = makeClient({ startingCsv: HEADER + daveRow })

    await updateStudent(client, {
      org: "acme",
      classroom: "cs101",
      key: "77",
      patch: {
        first_name: "David",
        last_name: "Davies",
        email: "dave@x.edu", // unchanged
        section: "Period 3",
      },
    })

    const dave = rowsFromCsv(committed.content!).find(
      (r) => r.github_id === "77",
    )
    expect(dave?.first_name).toBe("David")
    expect(dave?.last_name).toBe("Davies")
    expect(dave?.section).toBe("Period 3")
    expect(dave?.username).toBe("dave")
  })

  it("preserves the canonical column order and drops no other rows", async () => {
    const { client, committed } = makeClient({
      startingCsv: HEADER + aliceRow + bobRow,
    })

    await updateStudent(client, {
      org: "acme",
      classroom: "cs101",
      key: "42",
      patch: {
        first_name: "Alice",
        last_name: "A",
        email: "alice@x.edu",
        section: "Period 9",
      },
    })

    const csv = committed.content!
    expect(csv.split("\n")[0]).toBe(HEADER.trim())
    expect(rowsFromCsv(csv)).toHaveLength(2)
  })

  it("matches a username-only row by its username key (no github_id)", async () => {
    // carol: a row with a username but no github_id (key falls through to username).
    const carolRow = "carol,Carol,C,carol@x.edu,,\n"
    const { client, committed } = makeClient({ startingCsv: HEADER + carolRow })

    await updateStudent(client, {
      org: "acme",
      classroom: "cs101",
      key: "carol", // username key
      patch: {
        first_name: "Caroline",
        last_name: "Carter",
        email: "carol@x.edu",
        section: "Period 5",
      },
    })

    const carol = rowsFromCsv(committed.content!).find(
      (r) => r.username === "carol",
    )
    expect(carol?.first_name).toBe("Caroline")
    expect(carol?.last_name).toBe("Carter")
    expect(carol?.section).toBe("Period 5")
    expect(carol?.github_id).toBe("")
  })

  it("clears email via a whitespace-only email on a github-keyed row", async () => {
    const { client, committed } = makeClient({ startingCsv: HEADER + aliceRow })

    await updateStudent(client, {
      org: "acme",
      classroom: "cs101",
      key: "42",
      patch: { first_name: "Alice", last_name: "A", email: "   ", section: "" },
    })

    const alice = rowsFromCsv(committed.content!).find(
      (r) => r.github_id === "42",
    )
    expect(alice?.email).toBe("")
  })

  it("keeps a github-keyed row when all editable fields are cleared", async () => {
    const { client, committed } = makeClient({ startingCsv: HEADER + aliceRow })

    await updateStudent(client, {
      org: "acme",
      classroom: "cs101",
      key: "42",
      patch: { first_name: "", last_name: "", email: "", section: "" },
    })

    const rows = rowsFromCsv(committed.content!)
    const alice = rows.find((r) => r.github_id === "42")
    expect(alice).toBeTruthy()
    expect(alice?.username).toBe("alice")
    expect(rows).toHaveLength(1)
  })

  it("round-trips fields containing commas, quotes, and newlines without breaking the CSV", async () => {
    const { client, committed } = makeClient({ startingCsv: HEADER + aliceRow })

    await updateStudent(client, {
      org: "acme",
      classroom: "cs101",
      key: "42",
      patch: {
        first_name: 'Al"ice',
        last_name: "An, derson",
        email: "alice@x.edu",
        section: "Line1\nLine2",
      },
    })

    const csv = committed.content!
    const alice = rowsFromCsv(csv).find((r) => r.github_id === "42")
    expect(alice?.first_name).toBe('Al"ice')
    expect(alice?.last_name).toBe("An, derson")
    expect(alice?.section).toBe("Line1\nLine2")
    // No row-count corruption from the embedded delimiters/newline.
    expect(rowsFromCsv(csv)).toHaveLength(1)
  })

  it("escapes spreadsheet formula-injection in teacher-entered fields", async () => {
    const { client, committed } = makeClient({ startingCsv: HEADER + aliceRow })

    await updateStudent(client, {
      org: "acme",
      classroom: "cs101",
      key: "42",
      patch: {
        first_name: "=HYPERLINK(1)",
        last_name: "+CMD",
        email: "=1+1@x.edu",
        section: "@SUM(A1)",
      },
    })

    const alice = rowsFromCsv(committed.content!).find(
      (r) => r.github_id === "42",
    )
    // A leading formula char is neutralized with a quote prefix in the stored value.
    expect(alice?.first_name).toBe("'=HYPERLINK(1)")
    expect(alice?.last_name).toBe("'+CMD")
    expect(alice?.section).toBe("'@SUM(A1)")
    // email is also formula-guarded (member-controlled via sync/bulk import).
    expect(alice?.email).toBe("'=1+1@x.edu")
  })

  it("writes a descriptive commit message", async () => {
    const messages: string[] = []
    const committed: { content: string | null } = { content: null }
    const requestRaw = vi.fn().mockImplementation((path: string) => {
      if (path.includes("/contents/") && path.includes("classroom.json")) {
        return Promise.resolve(JSON.stringify({ short_name: "cs101" }))
      }
      return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
    })
    const request = vi
      .fn()
      .mockImplementation((path: string, options?: { body?: unknown }) => {
        if (/\/repos\/[^/]+\/classroom50$/.test(path))
          return { default_branch: "main" }
        if (path.includes("/contents/") && path.includes("roster.csv")) {
          return Promise.resolve({
            type: "file",
            encoding: "base64",
            content: Buffer.from(HEADER + aliceRow, "utf-8").toString("base64"),
          })
        }
        if (path.includes("/git/ref/")) {
          return Promise.resolve({ object: { sha: "base-sha" } })
        }
        if (path.includes("/git/commits/")) {
          return Promise.resolve({ tree: { sha: "base-tree-sha" } })
        }
        if (path.endsWith("/git/trees")) {
          return Promise.resolve({ sha: "tree-sha" })
        }
        if (path.endsWith("/git/commits")) {
          messages.push((options?.body as { message: string }).message)
          return Promise.resolve({ sha: "new-commit-sha" })
        }
        if (path.endsWith("/git/refs/heads/main")) {
          committed.content = "ok"
          return Promise.resolve({})
        }
        return Promise.reject(new Error(`unexpected request: ${path}`))
      })
    const client = { request, requestRaw } as unknown as GitHubClient

    await updateStudent(client, {
      org: "acme",
      classroom: "cs101",
      key: "42",
      patch: {
        first_name: "Alice",
        last_name: "A",
        email: "alice@x.edu",
        section: "Period 1",
      },
    })

    expect(messages[0]).toBe("[Classroom 50] Edit student: cs101/alice")
  })

  it("retries on a 409 conflict and lands the edit (updateStudentWithConflictRetry)", async () => {
    const committed: { content: string | null } = { content: null }
    let refUpdateAttempts = 0
    const requestRaw = vi.fn().mockImplementation((path: string) => {
      if (path.includes("/contents/") && path.includes("classroom.json")) {
        return Promise.resolve(JSON.stringify({ short_name: "cs101" }))
      }
      return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
    })
    const request = vi
      .fn()
      .mockImplementation((path: string, options?: { body?: unknown }) => {
        if (/\/repos\/[^/]+\/classroom50$/.test(path))
          return { default_branch: "main" }
        if (path.includes("/contents/") && path.includes("roster.csv")) {
          // On retry, serve the already-committed CSV if present.
          const csv = committed.content ?? HEADER + aliceRow
          return Promise.resolve({
            type: "file",
            encoding: "base64",
            content: Buffer.from(csv, "utf-8").toString("base64"),
          })
        }
        if (path.includes("/git/ref/")) {
          return Promise.resolve({ object: { sha: "base-sha" } })
        }
        if (path.includes("/git/commits/")) {
          return Promise.resolve({ tree: { sha: "base-tree-sha" } })
        }
        if (path.endsWith("/git/trees")) {
          const tree = (
            options?.body as { tree?: { path: string; content?: string }[] }
          )?.tree
          const entry = tree?.find((t) => t.path.includes("roster.csv"))
          if (entry?.content) committed.content = entry.content
          return Promise.resolve({ sha: "tree-sha" })
        }
        if (path.endsWith("/git/commits")) {
          return Promise.resolve({ sha: "new-commit-sha" })
        }
        if (path.endsWith("/git/refs/heads/main")) {
          refUpdateAttempts++
          if (refUpdateAttempts === 1) {
            // First updateRef loses the race: 409.
            committed.content = null
            return Promise.reject(
              new GitHubAPIError({
                status: 409,
                url: path,
                message: "conflict",
                body: null,
                rateLimit: {} as never,
              }),
            )
          }
          return Promise.resolve({})
        }
        return Promise.reject(new Error(`unexpected request: ${path}`))
      })
    const client = { request, requestRaw } as unknown as GitHubClient

    await updateStudentWithConflictRetry(client, {
      org: "acme",
      classroom: "cs101",
      key: "42",
      patch: {
        first_name: "Alicia",
        last_name: "A",
        email: "alice@x.edu",
        section: "Period 1",
      },
    })

    expect(refUpdateAttempts).toBe(2)
    const alice = rowsFromCsv(committed.content!).find(
      (r) => r.github_id === "42",
    )
    expect(alice?.first_name).toBe("Alicia")
  })
})

// Unenroll is classroom-scoped — it never removes an ACTIVE org member (that
// would leave other rosters showing them enrolled while non-member of the org).
// A pending invite is still cancelled. The fake tracks org-membership DELETEs
// and the committed roster so we can assert both.
describe("resolveClassroomPendingInvite — sole-classroom detection", () => {
  const makeInviteClient = (opts: {
    teamInvites: Array<{
      id: number
      login: string
      team_count?: number
      invitation_teams_url?: string | null
    }>
    inviteTeamsByUrl?: Record<string, Array<{ slug: string }>>
    failList?: boolean
  }) => {
    const request = vi.fn((path: string) => {
      if (path.includes("/teams/") && path.includes("/invitations")) {
        if (opts.failList) return Promise.reject(new Error("boom"))
        return Promise.resolve(opts.teamInvites)
      }
      if (opts.inviteTeamsByUrl && path in opts.inviteTeamsByUrl) {
        return Promise.resolve(opts.inviteTeamsByUrl[path])
      }
      return Promise.reject(new Error(`unexpected: ${path}`))
    })
    const requestRaw = vi.fn((path: string) => {
      if (path.includes("classroom.json")) {
        return Promise.resolve(JSON.stringify({ short_name: "cs101" }))
      }
      return Promise.reject(new Error(`unexpected raw: ${path}`))
    })
    return { request, requestRaw } as unknown as GitHubClient
  }

  const call = (client: GitHubClient) =>
    resolveClassroomPendingInvite(client, {
      org: "acme",
      classroom: "cs101",
      username: "bob",
      teamSlug: "classroom50-cs101",
    })

  it("sole-classroom when team_count is 1", async () => {
    const client = makeInviteClient({
      teamInvites: [{ id: 1, login: "bob", team_count: 1 }],
    })
    expect(await call(client)).toEqual({ invitationId: 1, soleClassroom: true })
  })

  it("NOT sole-classroom when team_count > 1", async () => {
    const client = makeInviteClient({
      teamInvites: [{ id: 1, login: "bob", team_count: 2 }],
    })
    expect(await call(client)).toEqual({
      invitationId: 1,
      soleClassroom: false,
    })
  })

  it("resolves invitation_teams_url when team_count is absent: single team matches", async () => {
    const client = makeInviteClient({
      teamInvites: [
        {
          id: 1,
          login: "bob",
          invitation_teams_url: "https://api.github.com/invites/1/teams",
        },
      ],
      inviteTeamsByUrl: {
        "https://api.github.com/invites/1/teams": [
          { slug: "classroom50-cs101" },
        ],
      },
    })
    expect(await call(client)).toEqual({ invitationId: 1, soleClassroom: true })
  })

  it("NOT sole-classroom when invitation_teams_url resolves to multiple teams", async () => {
    const client = makeInviteClient({
      teamInvites: [
        {
          id: 1,
          login: "bob",
          invitation_teams_url: "https://api.github.com/invites/1/teams",
        },
      ],
      inviteTeamsByUrl: {
        "https://api.github.com/invites/1/teams": [
          { slug: "classroom50-cs101" },
          { slug: "classroom50-cs201" },
        ],
      },
    })
    expect(await call(client)).toEqual({
      invitationId: 1,
      soleClassroom: false,
    })
  })

  it("matches the invite login case-insensitively", async () => {
    const client = makeInviteClient({
      teamInvites: [{ id: 9, login: "BoB", team_count: 1 }],
    })
    expect(await call(client)).toEqual({ invitationId: 9, soleClassroom: true })
  })

  it("returns no invite (fail safe) when the user has no pending invite on the team", async () => {
    const client = makeInviteClient({
      teamInvites: [{ id: 1, login: "someoneelse", team_count: 1 }],
    })
    expect(await call(client)).toEqual({ soleClassroom: false })
  })

  it("returns fail-safe (do not cancel) when the team-invitations read throws", async () => {
    const client = makeInviteClient({ teamInvites: [], failList: true })
    expect(await call(client)).toEqual({ soleClassroom: false })
  })
})

describe("unenrollStudent — classroom-scoped, no active-member org removal", () => {
  const aliceEnrolled = "alice,Alice,A,alice@x.edu,,42\n"
  const bobInvited = "bob,Bob,B,bob@x.edu,,43\n"

  const makeUnenrollClient = (opts: {
    startingCsv: string
    membershipState?: "active" | "pending" | null
    viewer?: { login: string; id: number }
    // Pending invitations listed under the classroom's team (GET
    // /orgs/{org}/teams/{slug}/invitations). Drives the sole-vs-multi-classroom
    // cancel decision. Defaults to a single sole-classroom invite for the
    // pending user so the legacy "cancels a pending invite" case still cancels.
    teamInvites?: Array<{
      id: number
      login: string
      team_count?: number
      invitation_teams_url?: string | null
    }>
    // Teams resolved from an invite's invitation_teams_url (keyed by URL).
    inviteTeamsByUrl?: Record<string, Array<{ slug: string }>>
    // When true, the invite-cancel DELETE rejects with a non-404 error so the
    // caller's non-fatal warning path can be exercised.
    failCancel?: boolean
  }) => {
    const committed: { content: string | null } = { content: null }
    const membershipState = opts.membershipState ?? null
    const orgMembershipDeletes: string[] = []
    const invitationDeletes: number[] = []
    // Default: one sole-classroom pending invite for "bob"/"alice" so an
    // unspecified pending test still exercises the cancel path.
    const teamInvites = opts.teamInvites ?? [
      { id: 7001, login: "bob", team_count: 1 },
      { id: 7002, login: "alice", team_count: 1 },
    ]

    const requestRaw = vi.fn().mockImplementation((path: string) => {
      if (path.includes("/contents/") && path.includes("classroom.json")) {
        return Promise.resolve(JSON.stringify({ short_name: "cs101" }))
      }
      return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
    })

    const request = vi
      .fn()
      .mockImplementation(
        (path: string, options?: { method?: string; body?: unknown }) => {
          if (/\/repos\/[^/]+\/classroom50$/.test(path))
            return { default_branch: "main" }
          if (path.includes("/contents/") && path.includes("roster.csv")) {
            const csv = committed.content ?? opts.startingCsv
            return Promise.resolve({
              type: "file",
              encoding: "base64",
              content: Buffer.from(csv, "utf-8").toString("base64"),
            })
          }
          if (path === "/user" || path.startsWith("/users/")) {
            return Promise.resolve(opts.viewer ?? { login: "teacher", id: 999 })
          }
          // Team-scoped pending invitations for the sole-classroom decision.
          if (path.includes("/teams/") && path.includes("/invitations")) {
            return Promise.resolve(teamInvites)
          }
          // A resolved invite's teams (invitation_teams_url), when routed here.
          if (opts.inviteTeamsByUrl && path in opts.inviteTeamsByUrl) {
            return Promise.resolve(opts.inviteTeamsByUrl[path])
          }
          // Cancel a specific invite by id: DELETE /orgs/{org}/invitations/{id}.
          if (
            /\/invitations\/\d+$/.test(path) &&
            (options?.method ?? "GET") === "DELETE"
          ) {
            if (opts.failCancel) {
              return Promise.reject(
                new GitHubAPIError({
                  status: 500,
                  url: path,
                  message: "boom",
                  body: null,
                  rateLimit: {} as never,
                }),
              )
            }
            const id = Number(path.split("/").pop())
            invitationDeletes.push(id)
            return Promise.resolve({})
          }
          // Org membership: GET returns state; DELETE is the removal/cancel we
          // assert on. Team memberships also hit /memberships/ but include
          // /teams/.
          if (path.includes("/memberships/") && !path.includes("/teams/")) {
            if ((options?.method ?? "GET") === "DELETE") {
              orgMembershipDeletes.push(path)
              return Promise.resolve({})
            }
            if (membershipState === null) {
              return Promise.reject(
                new GitHubAPIError({
                  status: 404,
                  url: path,
                  message: "not a member",
                  body: null,
                  rateLimit: {} as never,
                }),
              )
            }
            return Promise.resolve({ state: membershipState })
          }
          if (path.includes("/teams/")) {
            return Promise.resolve({})
          }
          // Onboarding-repo listing for a not-yet-enrolled reset.
          if (path.includes("/repos?")) {
            return Promise.resolve([])
          }
          if (path.includes("/git/ref/")) {
            return Promise.resolve({ object: { sha: "base-sha" } })
          }
          if (path.includes("/git/commits/")) {
            return Promise.resolve({ tree: { sha: "base-tree-sha" } })
          }
          if (path.endsWith("/git/trees")) {
            const tree = (
              options?.body as { tree?: { path: string; content?: string }[] }
            )?.tree
            const entry = tree?.find((t) => t.path.includes("roster.csv"))
            if (entry?.content) committed.content = entry.content
            return Promise.resolve({ sha: "tree-sha" })
          }
          if (path.endsWith("/git/commits")) {
            return Promise.resolve({ sha: "new-commit-sha" })
          }
          if (path.endsWith("/git/refs/heads/main")) {
            return Promise.resolve({})
          }
          return Promise.reject(new Error(`unexpected request: ${path}`))
        },
      )

    const client = { request, requestRaw } as unknown as GitHubClient
    return { client, committed, orgMembershipDeletes, invitationDeletes }
  }

  it("removes the roster row but never removes an ACTIVE org member", async () => {
    const { client, committed, orgMembershipDeletes, invitationDeletes } =
      makeUnenrollClient({
        startingCsv: HEADER + aliceEnrolled,
        membershipState: "active",
      })

    await unenrollStudent(client, {
      org: "acme",
      classroom: "cs101",
      student: {
        username: "alice",
        first_name: "Alice",
        last_name: "A",
        email: "alice@x.edu",
        section: "",
        github_id: "42",
        role: "",
      },
    })

    const rows = rowsFromCsv(committed.content!)
    expect(rows.find((r) => r.username === "alice")).toBeUndefined()
    // An active member is never removed/cancelled by EITHER mechanism.
    expect(orgMembershipDeletes).toHaveLength(0)
    expect(invitationDeletes).toHaveLength(0)
  })

  it("cancels a PENDING invite on unenroll when it's sole-classroom", async () => {
    const { client, committed, orgMembershipDeletes, invitationDeletes } =
      makeUnenrollClient({
        startingCsv: HEADER + bobInvited,
        membershipState: "pending",
        // bob's pending invite belongs solely to this classroom (team_count 1).
        teamInvites: [{ id: 7001, login: "bob", team_count: 1 }],
      })

    await unenrollStudent(client, {
      org: "acme",
      classroom: "cs101",
      student: {
        username: "bob",
        first_name: "Bob",
        last_name: "B",
        email: "bob@x.edu",
        section: "",
        github_id: "43",
        role: "",
      },
    })

    expect(
      rowsFromCsv(committed.content!).find((r) => r.username === "bob"),
    ).toBeUndefined()
    // Cancelled by the specific invitation id, NOT the org-wide membership DELETE.
    expect(invitationDeletes).toEqual([7001])
    expect(orgMembershipDeletes).toHaveLength(0)
  })

  it("keeps a PENDING invite that spans other classrooms (never revokes a sibling)", async () => {
    const { client, committed, orgMembershipDeletes, invitationDeletes } =
      makeUnenrollClient({
        startingCsv: HEADER + bobInvited,
        membershipState: "pending",
        // bob's pending invite carries this classroom's team AND another's.
        teamInvites: [{ id: 7001, login: "bob", team_count: 2 }],
      })

    const result = await unenrollStudent(client, {
      org: "acme",
      classroom: "cs101",
      student: {
        username: "bob",
        first_name: "Bob",
        last_name: "B",
        email: "bob@x.edu",
        section: "",
        github_id: "43",
        role: "",
      },
    })

    // Roster row still removed, but NO invite cancel of any kind.
    expect(
      rowsFromCsv(committed.content!).find((r) => r.username === "bob"),
    ).toBeUndefined()
    expect(invitationDeletes).toHaveLength(0)
    expect(orgMembershipDeletes).toHaveLength(0)
    // The teacher is warned the invite was kept.
    expect(result.teamWarning).toMatch(/other classrooms/i)
  })

  it("keeps a PENDING invite when its scope can't be confirmed (fail safe)", async () => {
    const { client, invitationDeletes, orgMembershipDeletes } =
      makeUnenrollClient({
        startingCsv: HEADER + bobInvited,
        membershipState: "pending",
        // No matching team invite found -> can't confirm sole-classroom.
        teamInvites: [],
      })

    const result = await unenrollStudent(client, {
      org: "acme",
      classroom: "cs101",
      student: {
        username: "bob",
        first_name: "Bob",
        last_name: "B",
        email: "bob@x.edu",
        section: "",
        github_id: "43",
        role: "",
      },
    })

    expect(invitationDeletes).toHaveLength(0)
    expect(orgMembershipDeletes).toHaveLength(0)
    expect(result.teamWarning).toBeDefined()
  })

  it("does not touch other rosters: only the target classroom's CSV is committed", async () => {
    const { client, committed, orgMembershipDeletes } = makeUnenrollClient({
      startingCsv: HEADER + aliceEnrolled,
      membershipState: "active",
    })

    await unenrollStudent(client, {
      org: "acme",
      classroom: "cs101",
      student: {
        username: "alice",
        first_name: "Alice",
        last_name: "A",
        email: "alice@x.edu",
        section: "",
        github_id: "42",
        role: "",
      },
    })

    // The only roster write is cs101's roster.csv (the committed content),
    // and no org-wide removal happened, so any other classroom Alice is on is
    // untouched and her org seat is intact.
    expect(committed.content).not.toBeNull()
    expect(orgMembershipDeletes).toHaveLength(0)
  })

  it("keeps the signed-in teacher's pending invite (self-guard)", async () => {
    const { client, orgMembershipDeletes, invitationDeletes } =
      makeUnenrollClient({
        startingCsv: HEADER + bobInvited,
        membershipState: "pending",
        // Even a sole-classroom invite must not be cancelled for self.
        teamInvites: [{ id: 7001, login: "bob", team_count: 1 }],
        viewer: { login: "bob", id: 43 },
      })

    const result = await unenrollStudent(client, {
      org: "acme",
      classroom: "cs101",
      student: {
        username: "bob",
        first_name: "Bob",
        last_name: "B",
        email: "bob@x.edu",
        section: "",
        github_id: "43",
        role: "",
      },
    })

    // Self: invite NOT cancelled by EITHER mechanism, and a warning explains why.
    expect(invitationDeletes).toHaveLength(0)
    expect(orgMembershipDeletes).toHaveLength(0)
    expect(result.teamWarning).toMatch(/signed-in account/i)
  })

  it("warns (non-fatal) when the sole-classroom invite cancel fails", async () => {
    const { client, committed, invitationDeletes } = makeUnenrollClient({
      startingCsv: HEADER + bobInvited,
      membershipState: "pending",
      teamInvites: [{ id: 7001, login: "bob", team_count: 1 }],
      // The invite-cancel DELETE rejects with a non-404 error.
      failCancel: true,
    })

    const result = await unenrollStudent(client, {
      org: "acme",
      classroom: "cs101",
      student: {
        username: "bob",
        first_name: "Bob",
        last_name: "B",
        email: "bob@x.edu",
        section: "",
        github_id: "43",
        role: "",
      },
    })

    // The roster commit still landed; the failure is a non-fatal warning.
    expect(
      rowsFromCsv(committed.content!).find((r) => r.username === "bob"),
    ).toBeUndefined()
    expect(invitationDeletes).toHaveLength(0) // the DELETE threw, nothing recorded
    expect(result.teamWarning).toMatch(
      /cancelling their pending org invite failed/i,
    )
  })
})

describe("bulkUnenrollStudents — single-commit batch removal", () => {
  const rosterWith = (usernames: string[]) =>
    HEADER +
    usernames.map((u, i) => `${u},,,${u}@x.edu,,${100 + i}`).join("\n") +
    "\n"

  const student = (username: string, github_id: string) => ({
    username,
    first_name: "",
    last_name: "",
    email: `${username}@x.edu`,
    section: "",
    github_id,
    role: "",
  })

  it("drops every matched row in exactly ONE commit", async () => {
    const { client, committed } = makeClient({
      startingCsv: rosterWith(["alice", "bob", "carol"]),
    })
    const request = client.request as ReturnType<typeof vi.fn>

    const result = await bulkUnenrollStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [student("alice", "100"), student("bob", "101")],
    })

    // The whole point: one roster commit for the batch, not one per student.
    const commitPosts = request.mock.calls.filter((c) =>
      String(c[0]).endsWith("/git/commits"),
    )
    expect(commitPosts).toHaveLength(1)

    // Only carol survives in the committed CSV.
    const survivors = rowsFromCsv(committed.content!).map((r) => r.username)
    expect(survivors).toEqual(["carol"])
    expect(result.removed.map((s) => s.username)).toEqual(["alice", "bob"])
    expect(result.notFound).toHaveLength(0)
  })

  it("cancels a sole-classroom pending invite but keeps a multi-classroom one", async () => {
    const { client, invitationDeletes } = makeClient({
      startingCsv: rosterWith(["alice", "bob"]),
      membershipState: "pending",
      // alice's invite is sole-classroom (team_count 1); bob's spans two.
      teamInvites: [
        { id: 8001, login: "alice", team_count: 1 },
        { id: 8002, login: "bob", team_count: 2 },
      ],
      // The viewer is neither, so neither is skipped as self.
      user: { login: "teacher", id: 999 },
    })

    const result = await bulkUnenrollStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [student("alice", "100"), student("bob", "101")],
    })

    expect(result.removed.map((s) => s.username)).toEqual(["alice", "bob"])
    // Only alice's sole-classroom invite is cancelled by id; bob's is kept.
    expect(invitationDeletes).toEqual([8001])
    expect(result.warnings.join(" ")).toMatch(/other classrooms/i)
  })

  it("reports rows already gone as notFound and still commits the rest", async () => {
    const { client, committed } = makeClient({
      startingCsv: rosterWith(["alice"]),
    })

    const result = await bulkUnenrollStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [student("alice", "100"), student("ghost", "999")],
    })

    expect(result.removed.map((s) => s.username)).toEqual(["alice"])
    expect(result.notFound.map((s) => s.username)).toEqual(["ghost"])
    const survivors = rowsFromCsv(committed.content ?? HEADER).map(
      (r) => r.username,
    )
    expect(survivors).toEqual([])
  })

  it("makes no commit when nothing matches", async () => {
    const { client, committed } = makeClient({
      startingCsv: rosterWith(["alice"]),
    })
    const request = client.request as ReturnType<typeof vi.fn>

    const result = await bulkUnenrollStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [student("ghost", "999")],
    })

    const commitPosts = request.mock.calls.filter((c) =>
      String(c[0]).endsWith("/git/commits"),
    )
    expect(commitPosts).toHaveLength(0)
    expect(result.removed).toHaveLength(0)
    expect(committed.content).toBeNull()
  })

  it("an email-only target matches nothing (identity is username/github_id only)", async () => {
    // Every roster row now carries a GitHub identity, so removal targets match
    // by username/github_id only. An email-only target (no username, no id)
    // matches no row — it can't silently unenroll a same-email sibling.
    const startingCsv = HEADER + "sam,,,sam@x.edu,,100\n"
    const { client, committed } = makeClient({ startingCsv })

    const result = await bulkUnenrollStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [
        {
          username: "",
          first_name: "",
          last_name: "",
          email: "sam@x.edu",
          section: "",
          github_id: "",
          role: "",
        },
      ],
    })

    // Nothing matched: the identified row survives, target reported notFound.
    expect(committed.content).toBeNull()
    expect(result.removed).toHaveLength(0)
    expect(result.notFound).toHaveLength(1)
  })

  // Regression (#130): removing the LAST student must not commit a header-less
  // file. Papa.unparse([]) yields "", so the pre-fix code wrote just "\n" — a
  // roster the CLI/skeleton readers reject. The emptied CSV must keep the
  // canonical header and round-trip through parseStudentsCsv to [].
  it("commits a header-only CSV that parses to [] when the last student is removed", async () => {
    const { client, committed } = makeClient({
      startingCsv: HEADER + "alice,,,alice@x.edu,,100\n",
    })

    const result = await bulkUnenrollStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [student("alice", "100")],
    })

    expect(result.removed.map((s) => s.username)).toEqual(["alice"])
    const csv = committed.content!
    expect(csv.split("\n")[0]).toBe(STUDENT_CSV_FIELDS.join(","))
    expect(parseStudentsCsv(csv)).toEqual([])
  })
})

// A fake client over multiple GitHub users, per-user org membership, and the
// classroom team. Drives bulkEnrollStudentsInClassroom / syncRosterFromTeam end
// to end (CSV read+commit, /users/{login}, membership
// GET, team-add PUT, team-members list). `users` maps login -> id/name/email;
// `members` is the set of ACTIVE org-member logins (case-insensitive); `teamHas`
// seeds the STUDENT team-member list, and `instructorHas`/`taHas` the staff
// teams (matched by the derived `classroom50-cs101[-role]` slug suffix) that
// syncRosterFromTeam now reads across all three teams.
type TeamMemberSeed = { login: string; id: number; name?: string | null }
const makeTeamClient = (opts: {
  startingCsv: string
  users: Record<
    string,
    { id: number; name?: string | null; email?: string | null }
  >
  members?: string[]
  teamHas?: TeamMemberSeed[]
  instructorHas?: TeamMemberSeed[]
  taHas?: TeamMemberSeed[]
  // Pending team invitations per role (login, and/or email for email-only
  // invitees). syncRosterFromTeam reads these so it never clears the role of a
  // person who is invited-but-not-yet-a-member.
  teamInvites?: { login?: string; email?: string }[]
  instructorInvites?: { login?: string; email?: string }[]
  taInvites?: { login?: string; email?: string }[]
  // When set, a members read for the instructor/ta team rejects with this
  // non-404 status (to exercise the best-effort staff-read degradation).
  staffReadRejects?: { role: "instructor" | "ta"; status: number }
}) => {
  const committed: { content: string | null } = { content: null }
  const memberSet = new Set((opts.members ?? []).map((m) => m.toLowerCase()))
  const teamAdds: string[] = []

  const requestRaw = vi.fn().mockImplementation((path: string) => {
    if (path.includes("/contents/") && path.includes("classroom.json")) {
      return Promise.resolve(JSON.stringify({ short_name: "cs101" }))
    }
    return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
  })

  const request = vi
    .fn()
    .mockImplementation((path: string, options?: { method?: string }) => {
      if (/\/repos\/[^/]+\/classroom50$/.test(path))
        return { default_branch: "main" }
      if (path.includes("/contents/") && path.includes("roster.csv")) {
        const csv = committed.content ?? opts.startingCsv
        return Promise.resolve({
          type: "file",
          encoding: "base64",
          content: Buffer.from(csv, "utf-8").toString("base64"),
        })
      }
      if (path.startsWith("/users/")) {
        const login = decodeURIComponent(path.slice("/users/".length))
        const u = opts.users[login]
        if (!u) return Promise.reject(new Error(`404 no such user: ${login}`))
        return Promise.resolve({ login, name: null, email: null, ...u })
      }
      // Team-add: PUT .../teams/{slug}/memberships/{login}
      if (path.includes("/teams/") && path.includes("/memberships/")) {
        const login = decodeURIComponent(path.split("/memberships/")[1])
        teamAdds.push(login)
        return Promise.resolve({ state: "active" })
      }
      // Team pending invitations (syncRosterFromTeam): GET
      // .../teams/{slug}/invitations. Route by slug to the seeded per-role list.
      if (path.includes("/teams/") && path.includes("/invitations")) {
        const slug = decodeURIComponent(
          path.split("/teams/")[1].split("/invitations")[0],
        )
        const seed = slug.endsWith("-instructor")
          ? (opts.instructorInvites ?? [])
          : slug.endsWith("-ta")
            ? (opts.taInvites ?? [])
            : (opts.teamInvites ?? [])
        return Promise.resolve(
          seed.map((i) => ({ login: i.login ?? null, email: i.email ?? null })),
        )
      }
      // Team members list (syncRosterFromTeam): GET .../teams/{slug}/members
      // (checked AFTER /memberships/ since "/members" is a substring of it).
      // Route by the derived slug so the student vs instructor vs ta teams
      // return their own seeded lists.
      if (path.includes("/teams/") && path.includes("/members")) {
        const slug = decodeURIComponent(
          path.split("/teams/")[1].split("/members")[0],
        )
        const rejects = opts.staffReadRejects
        if (rejects && slug.endsWith(`-${rejects.role}`)) {
          return Promise.reject(
            new GitHubAPIError({
              status: rejects.status,
              url: path,
              message: "boom",
              body: null,
              rateLimit: {
                limit: null,
                remaining: null,
                used: null,
                reset: null,
                resource: null,
                retryAfter: null,
              },
            }),
          )
        }
        const seed = slug.endsWith("-instructor")
          ? (opts.instructorHas ?? [])
          : slug.endsWith("-ta")
            ? (opts.taHas ?? [])
            : (opts.teamHas ?? [])
        const members = seed.map((m) => ({
          login: m.login,
          id: m.id,
          name: m.name ?? null,
        }))
        return Promise.resolve(members)
      }
      // Org membership state: GET /orgs/{org}/memberships/{login}
      if (path.includes("/memberships/") && !path.includes("/teams/")) {
        const login = decodeURIComponent(path.split("/memberships/")[1])
        if (memberSet.has(login.toLowerCase())) {
          return Promise.resolve({ state: "active" })
        }
        // A non-member is a real 404 (mirrors GitHub) so a status-aware caller
        // (assignRosterMemberRole) can tell "not a member" from a transient
        // read failure; isActiveMember-style callers swallow it to false anyway.
        return Promise.reject(
          new GitHubAPIError({
            status: 404,
            url: path,
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
          }),
        )
      }
      if (path.includes("/git/ref/")) {
        return Promise.resolve({ object: { sha: "base-sha" } })
      }
      if (path.includes("/git/commits/")) {
        return Promise.resolve({ tree: { sha: "base-tree-sha" } })
      }
      if (path.endsWith("/git/trees")) {
        const tree = (
          options as { body?: { tree?: { path: string; content?: string }[] } }
        )?.body?.tree
        const entry = tree?.find((t) => t.path.includes("roster.csv"))
        if (entry?.content != null) committed.content = entry.content
        return Promise.resolve({ sha: "tree-sha" })
      }
      if (path.endsWith("/git/commits")) {
        return Promise.resolve({ sha: "new-commit-sha" })
      }
      if (path.endsWith("/git/refs/heads/main")) {
        return Promise.resolve({})
      }
      return Promise.reject(new Error(`unexpected request: ${path}`))
    })

  return {
    client: { request, requestRaw } as unknown as GitHubClient,
    committed,
    teamAdds,
    request,
  }
}

describe("bulkEnrollStudentsInClassroom — verify org membership, flag non-members", () => {
  it("adds active org members to the team and skips non-members", async () => {
    const { client, committed, teamAdds } = makeTeamClient({
      startingCsv: HEADER,
      users: {
        ada: { id: 101, name: "Ada Lovelace" },
        bob: { id: 202, name: "Bob Bopson" },
      },
      members: ["ada"], // ada is a live org member; bob is not
    })

    const result = await bulkEnrollStudentsInClassroom(client, {
      org: "acme",
      classroom: "cs101",
      usernames: ["ada", "bob"],
    })

    // Both rows are written to roster.csv (roster is authoritative metadata)...
    const rows = rowsFromCsv(committed.content!)
    expect(rows.map((r) => r.username).sort()).toEqual(["ada", "bob"])
    expect(rows.find((r) => r.username === "ada")?.github_id).toBe("101")
    // ...but only the active member is team-added; the non-member (bob, not in
    // the org) is skipped and left for the upload's org-invite pass.
    expect(teamAdds).toEqual(["ada"])
    expect(result.teamResults).toEqual([{ username: "ada", status: "added" }])
  })

  it("dedupes an incoming username against an existing row by github_id, not stale login", async () => {
    // The CSV already has ada under a stale login; re-importing her current
    // login must be skipped as a github_id duplicate, not written twice.
    const startingCsv = HEADER + "ada-old,,,,,101\n"
    const { client, committed } = makeTeamClient({
      startingCsv,
      users: { ada: { id: 101 } },
      members: ["ada"],
    })

    await expect(
      bulkEnrollStudentsInClassroom(client, {
        org: "acme",
        classroom: "cs101",
        usernames: ["ada"],
      }),
    ).rejects.toThrow(/No new students to add/i)

    // No commit: the CSV is unchanged (github_id 101 already present).
    expect(committed.content).toBeNull()
  })

  it("writes full metadata from uploaded rows, GitHub profile only as fallback", async () => {
    const { client, committed } = makeTeamClient({
      startingCsv: HEADER,
      users: { cara: { id: 303, name: "Profile Name" } },
      members: ["cara"],
    })

    await bulkEnrollStudentsInClassroom(client, {
      org: "acme",
      classroom: "cs101",
      rows: [
        {
          username: "cara",
          first_name: "Cara",
          last_name: "Reyes",
          email: "cara@uni.edu",
          section: "Lab 2",
        },
      ],
    })

    const cara = rowsFromCsv(committed.content!).find(
      (r) => r.username === "cara",
    )
    expect(cara).toMatchObject({
      first_name: "Cara",
      last_name: "Reyes",
      email: "cara@uni.edu",
      section: "Lab 2",
      github_id: "303",
    })
  })
})

describe("syncRosterFromTeam — identity-only backfill", () => {
  it("appends an identity-only row (username + github_id, blank metadata)", async () => {
    const { client, committed } = makeTeamClient({
      startingCsv: HEADER,
      users: {},
      // Team member carries a profile name/email, but sync must NOT fabricate
      // them into the CSV — identity only.
      teamHas: [{ login: "grace", id: 707, name: "Grace Hopper" }],
    })

    const result = await syncRosterFromTeam(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.noop).toBe(false)
    expect(result.addedUsernames).toEqual(["grace"])
    const grace = rowsFromCsv(committed.content!).find(
      (r) => r.username === "grace",
    )
    expect(grace).toMatchObject({
      username: "grace",
      github_id: "707",
      first_name: "",
      last_name: "",
      email: "",
      section: "",
      // Student-team member records the "student" role.
      role: "student",
    })
  })

  it("backfills a blank github_id on a login-matched row (the login-only-row case)", async () => {
    // Teacher wrote a bare username, invited, the student joined the team — but
    // the row still has no github_id. Sync must fill it in from the team member.
    const { client, committed } = makeTeamClient({
      startingCsv: HEADER + "student1,,,,,,\n",
      users: {},
      teamHas: [{ login: "student1", id: 127826836 }],
    })

    const result = await syncRosterFromTeam(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.noop).toBe(false)
    const backfilled = rowsFromCsv(committed.content!).find(
      (r) => r.username === "student1",
    )
    expect(backfilled).toMatchObject({
      username: "student1",
      github_id: "127826836",
      role: "student",
    })
  })

  it("never overwrites an existing github_id (renamed-login safety)", async () => {
    // The CSV row already has an id; a team member sharing the login but a
    // DIFFERENT id must not repoint the row onto the other account.
    const { client, committed } = makeTeamClient({
      startingCsv: HEADER + "student1,,,,,999,student\n",
      users: {},
      teamHas: [{ login: "student1", id: 127826836 }],
    })

    const result = await syncRosterFromTeam(client, {
      org: "acme",
      classroom: "cs101",
    })

    // Role already correct + id must be preserved -> nothing to change.
    expect(result.noop).toBe(true)
    const preserved = rowsFromCsv(
      committed.content ?? HEADER + "student1,,,,,999,student\n",
    ).find((r) => r.username === "student1")
    expect(preserved?.github_id).toBe("999")
  })

  it("leaves a blank-id row untouched when its login is on no team", async () => {
    const { client } = makeTeamClient({
      startingCsv: HEADER + "ghost,,,,,,\n",
      users: {},
      teamHas: [],
    })

    const result = await syncRosterFromTeam(client, {
      org: "acme",
      classroom: "cs101",
    })

    // No team members at all -> nothing to backfill or append.
    expect(result.noop).toBe(true)
  })

  it("syncs instructors and TAs with their role, not just students", async () => {
    // The nice-classroom scenario: only an instructor and a TA, no students,
    // and no roster.csv rows yet. Both must be appended with their role so the
    // roster is populated from the staff teams alone.
    const { client, committed } = makeTeamClient({
      startingCsv: HEADER,
      users: {},
      teamHas: [], // no student-team members
      instructorHas: [{ login: "prof", id: 1 }],
      taHas: [{ login: "helper", id: 2 }],
    })

    const result = await syncRosterFromTeam(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.noop).toBe(false)
    expect(result.addedUsernames.sort()).toEqual(["helper", "prof"])
    const rows = rowsFromCsv(committed.content!)
    expect(rows.find((r) => r.username === "prof")).toMatchObject({
      github_id: "1",
      role: "instructor",
    })
    expect(rows.find((r) => r.username === "helper")).toMatchObject({
      github_id: "2",
      role: "ta",
    })
  })

  it("records the highest-precedence role for a member on multiple teams", async () => {
    // An instructor who is also on the student team records "instructor"
    // (instructor > ta > student), matching the roster view's primary role.
    const { client, committed } = makeTeamClient({
      startingCsv: HEADER,
      users: {},
      teamHas: [{ login: "prof", id: 1 }], // also a student-team member
      instructorHas: [{ login: "prof", id: 1 }],
    })

    const result = await syncRosterFromTeam(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.addedUsernames).toEqual(["prof"])
    const rows = rowsFromCsv(committed.content!)
    // One row, not one per team.
    expect(rows.filter((r) => r.username === "prof")).toHaveLength(1)
    expect(rows[0].role).toBe("instructor")
  })

  it("refreshes a role that changed (promotion) on an existing row", async () => {
    // grace was recorded as a student; she's now on the instructor team. Sync
    // updates her role in place without adding a row.
    const { client, committed } = makeTeamClient({
      startingCsv: HEADER + "grace,Grace,Hopper,g@x.edu,A,707,student\n",
      users: {},
      teamHas: [],
      instructorHas: [{ login: "grace", id: 707 }],
    })

    const result = await syncRosterFromTeam(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.addedUsernames).toEqual([])
    expect(result.noop).toBe(false)
    const grace = rowsFromCsv(committed.content!).find(
      (r) => r.username === "grace",
    )
    // role refreshed; teacher-owned metadata untouched.
    expect(grace).toMatchObject({
      role: "instructor",
      first_name: "Grace",
      email: "g@x.edu",
      section: "A",
    })
  })

  it("clears the role of a row whose person is on no team (removed staffer)", async () => {
    // tara was a TA (role recorded), then removed from the staff team. She's on
    // no team now, so sync clears her role to "" while keeping her row and
    // teacher-owned metadata — the CSV stops disagreeing with the team.
    const { client, committed } = makeTeamClient({
      startingCsv: HEADER + "tara,Tara,Vance,t@x.edu,B,55,ta\n",
      users: {},
      teamHas: [],
      instructorHas: [],
      taHas: [], // removed from the ta team
    })

    const result = await syncRosterFromTeam(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.addedUsernames).toEqual([])
    expect(result.noop).toBe(false) // a role change happened
    const tara = rowsFromCsv(committed.content!).find(
      (r) => r.username === "tara",
    )
    // Row kept, metadata intact, role cleared.
    expect(tara).toMatchObject({
      username: "tara",
      github_id: "55",
      first_name: "Tara",
      email: "t@x.edu",
      section: "B",
      role: "",
    })
  })

  it("does NOT clear the role of a pending invitee (still on no team)", async () => {
    // prof was just invited as an instructor (org owner) and their role was
    // written to roster.csv, but they haven't accepted yet — so they're on no
    // team. A pending instructor-team invite must preserve the recorded role;
    // clearing it here would wipe the writeback for the whole pending window.
    const { client, committed } = makeTeamClient({
      startingCsv: HEADER + "prof,,,,,9,instructor\n" + "ada,,,,,101,\n", // a co-occurring backfill row makes sync run
      users: {},
      teamHas: [{ login: "ada", id: 101 }],
      instructorHas: [], // prof not yet a member
      instructorInvites: [{ login: "prof" }], // ...but has a pending invite
    })

    const result = await syncRosterFromTeam(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.noop).toBe(false) // ada's role backfill still runs
    const prof = rowsFromCsv(committed.content!).find(
      (r) => r.username === "prof",
    )
    expect(prof?.role).toBe("instructor") // preserved, not cleared to ""
  })

  it("clears a stale role when the person is on no team AND has no pending invite", async () => {
    // The pending-preservation guard must be narrow: no membership and no
    // pending invite still clears (the removed-staffer case), even when another
    // row drives the sync.
    const { client, committed } = makeTeamClient({
      startingCsv: HEADER + "gone,,,,,77,ta\n" + "ada,,,,,101,\n",
      users: {},
      teamHas: [{ login: "ada", id: 101 }],
      taHas: [],
      taInvites: [], // no pending invite for gone
    })

    await syncRosterFromTeam(client, { org: "acme", classroom: "cs101" })

    const gone = rowsFromCsv(committed.content!).find(
      (r) => r.username === "gone",
    )
    expect(gone?.role).toBe("")
  })

  it("does NOT clear an active staffer's role when a staff-team read degrades", async () => {
    // grace is a current instructor, but the instructor-team read transiently
    // 500s (degrades to []). Sync must NOT treat "absent from the degraded read"
    // as "removed" and wipe her recorded role — the read was incomplete.
    const { client, committed } = makeTeamClient({
      startingCsv: HEADER + "grace,Grace,Hopper,g@x.edu,A,707,instructor\n",
      users: {},
      teamHas: [],
      instructorHas: [{ login: "grace", id: 707 }],
      staffReadRejects: { role: "instructor", status: 500 },
    })

    const result = await syncRosterFromTeam(client, {
      org: "acme",
      classroom: "cs101",
    })

    // No append, and crucially no role change from the incomplete read.
    expect(result.addedUsernames).toEqual([])
    expect(result.noop).toBe(true)
    if (committed.content !== null) {
      const grace = rowsFromCsv(committed.content).find(
        (r) => r.username === "grace",
      )
      expect(grace?.role).toBe("instructor")
    }
  })

  it("a non-404 failure on a staff-team read degrades to [] and still syncs students", async () => {
    // The instructor-team read 500s; that must NOT fail the whole sync — the
    // student-team member is still backfilled (staff reads are best-effort).
    const { client, committed } = makeTeamClient({
      startingCsv: HEADER,
      users: {},
      teamHas: [{ login: "stu", id: 10 }],
      instructorHas: [{ login: "prof", id: 1 }], // would be added, but read 500s
      staffReadRejects: { role: "instructor", status: 500 },
    })

    const result = await syncRosterFromTeam(client, {
      org: "acme",
      classroom: "cs101",
    })

    // The student synced; the instructor (whose read failed) did not, but the
    // sync as a whole succeeded rather than throwing.
    expect(result.addedUsernames).toEqual(["stu"])
    const rows = rowsFromCsv(committed.content!)
    expect(rows.map((r) => r.username)).toEqual(["stu"])
    expect(rows[0].role).toBe("student")
  })

  it("is a noop when every team member already has a CSV row with its role", async () => {
    const { client, committed } = makeTeamClient({
      startingCsv: HEADER + "grace,,,,,707,student\n",
      users: {},
      teamHas: [{ login: "grace", id: 707 }],
    })

    const result = await syncRosterFromTeam(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.noop).toBe(true)
    expect(committed.content).toBeNull()
  })

  // A pre-role row for an existing team member gets its recorded role refreshed
  // in place (a role-only convergence), even though no member is missing.
  it("refreshes a missing/stale role on an existing row without adding rows", async () => {
    const { client, committed } = makeTeamClient({
      startingCsv: HEADER + "grace,,,,,707\n", // role column empty
      users: {},
      teamHas: [{ login: "grace", id: 707 }],
    })

    const result = await syncRosterFromTeam(client, {
      org: "acme",
      classroom: "cs101",
    })

    // No member was missing, so nothing was appended...
    expect(result.addedUsernames).toEqual([])
    expect(result.noop).toBe(false)
    // ...but the role was written, so a commit did happen.
    const rows = rowsFromCsv(committed.content!)
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe("student")
  })

  // Regression: a roster hand-edited (or exported by a tool that drops empty
  // trailing columns) has rows with the empty trailing column omitted, e.g.
  // `octocat,Grace,Hopper,g@x.edu,Section A,1` (the trailing `role` dropped).
  // Papa flags TooFewFields, but the row is benign (missing trailing field ->
  // ""), so the parse must NOT throw and sync must still see the row's identity.
  it("tolerates short rows missing the trailing role column", async () => {
    const shortRows =
      "octocat,Grace,Hopper,grace@example.edu,Section A,1\n" +
      "torvalds,Linus,Torvalds,linus@example.edu,Section A,2\n"
    const { client } = makeTeamClient({
      startingCsv: HEADER + shortRows,
      users: {},
      // Both short-row students are already team members matched by id, so no
      // member is missing — the point is that parsing the short rows doesn't
      // throw. (Their empty role is refreshed to "student" in place, so this is
      // not a no-op, but nothing is appended.)
      teamHas: [
        { login: "octocat", id: 1 },
        { login: "torvalds", id: 2 },
      ],
    })

    const result = await syncRosterFromTeam(client, {
      org: "acme",
      classroom: "cs101",
    })

    // octocat/torvalds are matched by id, so nothing is backfilled and the
    // short rows parsed without error.
    expect(result.addedUsernames).toEqual([])
  })
})

describe("writeRosterRoles — set role on existing rows", () => {
  it("writes the assigned role onto a matching row and commits", async () => {
    const { client, committed } = makeTeamClient({
      startingCsv: HEADER + "prof,,,,,9,\n",
      users: {},
      teamHas: [],
    })

    const res = await writeRosterRoles(client, {
      org: "acme",
      classroom: "cs101",
      roles: [{ username: "prof", role: "instructor" }],
    })

    expect(res.changed).toBe(1)
    const prof = rowsFromCsv(committed.content!).find(
      (r) => r.username === "prof",
    )
    expect(prof?.role).toBe("instructor")
  })

  it("no-ops when the role already matches (no commit)", async () => {
    const { client, committed } = makeTeamClient({
      startingCsv: HEADER + "prof,,,,,9,instructor\n",
      users: {},
      teamHas: [],
    })

    const res = await writeRosterRoles(client, {
      org: "acme",
      classroom: "cs101",
      roles: [{ username: "prof", role: "instructor" }],
    })

    expect(res.changed).toBe(0)
    expect(committed.content).toBeNull()
  })

  it("throws RosterCsvMalformedError on a malformed roster.csv (no commit)", async () => {
    // The self-healing case: a stray-comma sibling row (8 fields vs 7). The
    // writeback must NOT silently rewrite (positional re-serialize would corrupt
    // the bad row) nor swallow — it raises a typed error the caller surfaces.
    const { client, committed } = makeTeamClient({
      startingCsv: HEADER + "prof,,,,,9,\n" + "student1,,,,,,,\n",
      users: {},
      teamHas: [],
    })

    await expect(
      writeRosterRoles(client, {
        org: "acme",
        classroom: "cs101",
        roles: [{ username: "prof", role: "instructor" }],
      }),
    ).rejects.toBeInstanceOf(RosterCsvMalformedError)
    expect(committed.content).toBeNull() // nothing written
  })

  it("no-ops for a username absent from the CSV (never appends a row)", async () => {
    const { client, committed } = makeTeamClient({
      startingCsv: HEADER + "prof,,,,,9,instructor\n",
      users: {},
      teamHas: [],
    })

    const res = await writeRosterRoles(client, {
      org: "acme",
      classroom: "cs101",
      roles: [{ username: "ghost", role: "ta" }],
    })

    expect(res.changed).toBe(0)
    expect(committed.content).toBeNull()
  })

  it("no-ops (no git read/commit) for an empty roles input", async () => {
    const { client, committed, request } = makeTeamClient({
      startingCsv: HEADER + "prof,,,,,9,instructor\n",
      users: {},
      teamHas: [],
    })

    const res = await writeRosterRoles(client, {
      org: "acme",
      classroom: "cs101",
      roles: [],
    })

    expect(res.changed).toBe(0)
    expect(committed.content).toBeNull()
    // Early return before any ref read or commit.
    expect(request).not.toHaveBeenCalled()
  })
})

describe("parseStudentsCsv — short-row tolerance is trailing-only", () => {
  const HEADER = STUDENT_CSV_FIELDS.join(",") + "\n"

  it("parses a row missing the trailing role column into correct fields", () => {
    // 6 fields: the empty trailing role column omitted. The row must parse
    // (not throw) AND keep every value in its own column, with role -> "".
    const rows = parseStudentsCsv(
      HEADER + "octocat,Grace,Hopper,grace@example.edu,Section A,42\n",
    )
    expect(rows).toEqual([
      {
        username: "octocat",
        first_name: "Grace",
        last_name: "Hopper",
        email: "grace@example.edu",
        section: "Section A",
        github_id: "42",
        role: "",
      },
    ])
  })

  it("throws on a row short by more than one column", () => {
    // 5 fields — short by 2 (github_id AND role dropped). A row this incomplete
    // can't be a mere dropped trailing column; Papa would map its values into
    // the wrong columns, so the trailing-only guard must reject it rather than
    // silently misalign identity. (A row short by exactly one is inherently
    // ambiguous and is treated as the optional trailing column being omitted —
    // see above.)
    expect(() =>
      parseStudentsCsv(
        HEADER + "octocat,Grace,Hopper,grace@example.edu,Sec A\n",
      ),
    ).toThrow(/roster\.csv/)
  })

  it("still rejects a TooManyFields (extra column) row as before", () => {
    expect(() =>
      parseStudentsCsv(
        HEADER + "octocat,Grace,Hopper,g@x.edu,Sec A,42,student,extra\n",
      ),
    ).toThrow(/roster\.csv/)
  })
})

describe("parseRosterCsv — structured per-line problems", () => {
  const HEADER = STUDENT_CSV_FIELDS.join(",") + "\n"

  it("reports the exact malformed line for a too-many-fields row (the login-only-row case)", () => {
    // The real bug: a hand-written row with one comma too many (8 fields vs 7).
    const csv =
      HEADER + "rongxin-liu,,,,,10591665,instructor\n" + "student1,,,,,,,\n"
    const { rows, problems } = parseRosterCsv(csv)
    expect(problems).toHaveLength(1)
    // Header is line 1; rongxin-liu line 2; the malformed student1 row is line 3.
    expect(problems[0].line).toBe(3)
    expect(problems[0].message).toMatch(/too many fields/i)
    // Rows are still returned (the view stays tolerant) — the good row parses.
    expect(rows.some((r) => r.username === "rongxin-liu")).toBe(true)
  })

  it("returns no problems for a well-formed roster", () => {
    const csv = HEADER + "octocat,Grace,Hopper,g@x.edu,Sec A,42,student\n"
    const { problems } = parseRosterCsv(csv)
    expect(problems).toEqual([])
  })

  it("treats a row short by exactly one trailing column as benign (no problem)", () => {
    const csv = HEADER + "octocat,Grace,Hopper,g@x.edu,Sec A,42\n"
    const { problems } = parseRosterCsv(csv)
    expect(problems).toEqual([])
  })

  it("flags a row short by more than one column", () => {
    const csv = HEADER + "octocat,Grace,Hopper,g@x.edu,Sec A\n"
    const { problems } = parseRosterCsv(csv)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems[0].line).toBe(2)
  })
})

// Fresh org invites for not_in_org roster students. A minimal fake client:
// classroom.json (no team block -> derived slug, no team id), org-membership
// state (404 = not a member), /users/{login} resolution, and the invitation
// POST. Records invitations so we can assert what got sent.
const makeInviteClient = (opts: {
  users?: Record<string, { id: number }>
  members?: string[]
  // Logins the org reports as having a still-pending invite (state "pending").
  pending?: string[]
  invitationFails?: boolean
  // When set, the Nth (0-based) POST /invitations rejects with a 429 rate limit
  // and every later POST would too — used to exercise the mid-batch short-circuit.
  rateLimitFromInvite?: number
  // When set, ONLY the first N POST /invitations attempts 429; later attempts
  // succeed — used to exercise the Retry-After-backed retry of the deferred set.
  rateLimitFirstN?: number
}) => {
  const invitations: { invitee_id?: number; team_ids?: number[] }[] = []
  const memberSet = new Set((opts.members ?? []).map((m) => m.toLowerCase()))
  const pendingSet = new Set((opts.pending ?? []).map((m) => m.toLowerCase()))
  let inviteAttempts = 0

  const rateLimitError = () =>
    new GitHubAPIError({
      status: 429,
      url: "/orgs/acme/invitations",
      message: "You have exceeded a secondary rate limit",
      body: null,
      rateLimit: {
        limit: null,
        remaining: null,
        used: null,
        reset: null,
        resource: null,
        retryAfter: 60,
      },
    })

  const requestRaw = vi.fn().mockImplementation((path: string) => {
    if (path.includes("classroom.json")) {
      // Non-archived classroom for the archive guard; no team block so
      // resolveClassroomTeam derives the slug and finds no team id.
      return Promise.resolve(JSON.stringify({ short_name: "cs101" }))
    }
    return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
  })

  const request = vi
    .fn()
    .mockImplementation((path: string, options?: { method?: string }) => {
      if (/\/repos\/[^/]+\/classroom50$/.test(path))
        return { default_branch: "main" }
      if (path.startsWith("/users/")) {
        const login = decodeURIComponent(path.slice("/users/".length))
        const u = opts.users?.[login]
        if (!u) return Promise.reject(new Error(`404 no such user: ${login}`))
        return Promise.resolve({ login, id: u.id })
      }
      if (path.includes("/memberships/") && !path.includes("/teams/")) {
        const login = decodeURIComponent(path.split("/memberships/")[1])
        if (memberSet.has(login.toLowerCase())) {
          return Promise.resolve({ state: "active" })
        }
        if (pendingSet.has(login.toLowerCase())) {
          return Promise.resolve({ state: "pending" })
        }
        return Promise.reject(new Error("404 not a member"))
      }
      if (path.endsWith("/invitations") && options?.method === "POST") {
        const attempt = inviteAttempts++
        if (
          opts.rateLimitFromInvite !== undefined &&
          attempt >= opts.rateLimitFromInvite
        ) {
          return Promise.reject(rateLimitError())
        }
        if (
          opts.rateLimitFirstN !== undefined &&
          attempt < opts.rateLimitFirstN
        ) {
          return Promise.reject(rateLimitError())
        }
        if (opts.invitationFails) {
          return Promise.reject(new Error("invite blew up"))
        }
        const body = (options as { body?: { invitee_id?: number } }).body
        invitations.push(body ?? {})
        return Promise.resolve({})
      }
      // Staff-team creation (resolveTeamIdByRole -> ensureClassroomRoleTeam).
      // Create returns a fresh team; the config-repo write grant is a no-op PUT.
      if (path.endsWith("/teams") && options?.method === "POST") {
        const body = (options as { body?: { name?: string } }).body
        const name = body?.name ?? "team"
        return Promise.resolve({ id: 5000, slug: name, privacy: "secret" })
      }
      if (path.includes("/teams/") && path.includes("/repos/")) {
        return Promise.resolve({})
      }
      return Promise.reject(new Error(`unexpected request: ${path}`))
    })

  return {
    client: { request, requestRaw } as unknown as GitHubClient,
    invitations,
  }
}

describe("inviteRosterStudents — fresh invites for not_in_org students", () => {
  it("invites by the stored github_id when present", async () => {
    const { client, invitations } = makeInviteClient({ members: [] })

    const res = await inviteRosterStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [{ username: "octocat", github_id: "1" }],
    })

    expect(res.invited).toEqual([{ username: "octocat", role: "student" }])
    expect(invitations).toEqual([{ invitee_id: 1, role: "direct_member" }])
  })

  it("resolves the id from the username when github_id is missing", async () => {
    const { client, invitations } = makeInviteClient({
      users: { torvalds: { id: 2 } },
    })

    const res = await inviteRosterStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [{ username: "torvalds", github_id: "" }],
    })

    expect(res.invited).toEqual([{ username: "torvalds", role: "student" }])
    expect(invitations).toEqual([{ invitee_id: 2, role: "direct_member" }])
  })

  it("does not create staff teams for a students-only upload", async () => {
    // resolveTeamIdByRole must only ensure a staff team for a role actually
    // present. A students-only invite must not create/grant instructor/ta teams.
    const teamWrites: string[] = []
    const { client, invitations } = makeInviteClient({
      users: { stu: { id: 5 } },
      members: [],
    })
    // Wrap request to record any team-membership/creation write.
    const orig = client.request as unknown as (
      p: string,
      o?: { method?: string },
    ) => Promise<unknown>
    ;(client as unknown as { request: typeof orig }).request = (p, o) => {
      if (
        p.includes("/teams") ||
        (p.includes("/orgs/") && p.endsWith("/teams"))
      )
        teamWrites.push(p)
      return orig(p, o)
    }

    await inviteRosterStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [{ username: "stu", github_id: "5", role: "student" }],
    })

    expect(teamWrites).toEqual([])
    expect(invitations[0]).toMatchObject({ role: "direct_member" })
  })

  it("invites an instructor row as an organization OWNER (role admin)", async () => {
    const { client, invitations } = makeInviteClient({
      users: { prof: { id: 9 } },
      members: [],
    })

    const res = await inviteRosterStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [{ username: "prof", github_id: "9", role: "instructor" }],
    })

    expect(res.invited).toEqual([{ username: "prof", role: "instructor" }])
    // The org invite must carry admin (owner), not direct_member.
    expect(invitations[0]).toMatchObject({ invitee_id: 9, role: "admin" })
  })

  it("invites a ta row as a plain member (direct_member), not an owner", async () => {
    const { client, invitations } = makeInviteClient({
      users: { helper: { id: 8 } },
      members: [],
    })

    const res = await inviteRosterStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [{ username: "helper", github_id: "8", role: "ta" }],
    })

    expect(res.invited).toEqual([{ username: "helper", role: "ta" }])
    // A TA is a plain org member; only instructor -> admin.
    expect(invitations[0]).toMatchObject({
      invitee_id: 8,
      role: "direct_member",
    })
  })

  it("dispatches org role per target in a mixed-role batch", async () => {
    const { client, invitations } = makeInviteClient({
      users: { stu: { id: 1 }, helper: { id: 2 }, prof: { id: 3 } },
      members: [],
    })

    const res = await inviteRosterStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [
        { username: "stu", github_id: "1", role: "student" },
        { username: "helper", github_id: "2", role: "ta" },
        { username: "prof", github_id: "3", role: "instructor" },
      ],
    })

    expect(res.invited).toEqual(
      expect.arrayContaining([
        { username: "stu", role: "student" },
        { username: "helper", role: "ta" },
        { username: "prof", role: "instructor" },
      ]),
    )
    // Only the instructor is invited as an org owner (admin); the rest are plain.
    const byId = new Map(invitations.map((i) => [i.invitee_id, i]))
    expect(byId.get(1)).toMatchObject({ role: "direct_member" })
    expect(byId.get(2)).toMatchObject({ role: "direct_member" })
    expect(byId.get(3)).toMatchObject({ role: "admin" })
  })

  it("does not escalate an existing active member for an instructor row", async () => {
    // The no-escalation invariant: ensureOrgMembership short-circuits an
    // active/pending member BEFORE createOrgInvitation, so an instructor-role
    // upload of an already-member never sends an admin (owner) invite.
    const { client, invitations } = makeInviteClient({
      users: { prof: { id: 9 } },
      members: ["prof"],
    })

    const res = await inviteRosterStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [{ username: "prof", github_id: "9", role: "instructor" }],
    })

    expect(res.invited).toEqual([])
    expect(res.skipped).toEqual([
      { username: "prof", reason: "already-member" },
    ])
    // No invite at all -> no admin escalation of the existing member.
    expect(invitations).toEqual([])
  })

  it("does not escalate an existing pending member for an instructor row", async () => {
    const { client, invitations } = makeInviteClient({
      users: { prof: { id: 9 } },
      pending: ["prof"],
    })

    const res = await inviteRosterStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [{ username: "prof", github_id: "9", role: "instructor" }],
    })

    expect(res.invited).toEqual([])
    expect(res.skipped).toEqual([
      { username: "prof", reason: "already-pending" },
    ])
    expect(invitations).toEqual([])
  })

  it("skips an already-active member without inviting", async () => {
    const { client, invitations } = makeInviteClient({
      members: ["octocat"],
    })

    const res = await inviteRosterStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [{ username: "octocat", github_id: "1" }],
    })

    expect(res.invited).toEqual([])
    expect(res.skipped).toEqual([
      { username: "octocat", reason: "already-member" },
    ])
    expect(invitations).toEqual([])
  })

  it("reports a row whose username can't be resolved as failed", async () => {
    const { client } = makeInviteClient({ users: {} })

    const res = await inviteRosterStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [{ username: "ghost", github_id: "" }],
    })

    expect(res.invited).toEqual([])
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0].username).toBe("ghost")
  })

  it("skips a row that already has a pending invite", async () => {
    const { client, invitations } = makeInviteClient({
      pending: ["octocat"],
    })

    const res = await inviteRosterStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [{ username: "octocat", github_id: "1" }],
    })

    expect(res.invited).toEqual([])
    expect(res.skipped).toEqual([
      { username: "octocat", reason: "already-pending" },
    ])
    // A pending invite already exists, so no new invitation is POSTed.
    expect(invitations).toEqual([])
  })

  it("stops inviting and defers the rest once a rate limit is hit", async () => {
    // First invite trips a 429; every remaining target should be deferred, not
    // re-fired at the throttled endpoint.
    const { client, invitations } = makeInviteClient({
      rateLimitFromInvite: 0,
    })

    const res = await inviteRosterStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [
        { username: "a", github_id: "1" },
        { username: "b", github_id: "2" },
        { username: "c", github_id: "3" },
      ],
      // Isolate the mid-batch short-circuit from the Retry-After retry pass
      // (covered by its own test): with the endpoint throttled indefinitely,
      // skip retries so this asserts the first-pass defer behavior.
      maxRetries: 0,
    })

    expect(res.invited).toEqual([])
    expect(res.failed).toEqual([])
    // All three land in deferred: the first from the rate-limited catch, the
    // rest from the short-circuit that skips work once the flag is set.
    expect(res.deferred.sort()).toEqual(["a", "b", "c"])
    // Only the one attempt that tripped the limit was POSTed; no further invites
    // were fired at the throttled endpoint.
    expect(invitations).toEqual([])
  })

  it("auto-retries a deferred (rate-limited) target honoring Retry-After", async () => {
    // The first POST 429s (deferring the target); the retry pass sleeps the
    // honored Retry-After and re-attempts, which succeeds. Injected sleepFn
    // keeps the test instant and records the honored delay.
    const { client, invitations } = makeInviteClient({ rateLimitFirstN: 1 })
    const slept: number[] = []

    const res = await inviteRosterStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [{ username: "a", github_id: "1" }],
      sleepFn: async (ms) => {
        slept.push(ms)
      },
    })

    expect(res.invited).toEqual([{ username: "a", role: "student" }])
    expect(res.deferred).toEqual([])
    expect(res.failed).toEqual([])
    // Honored the 60s Retry-After from the rate-limit error.
    expect(slept.some((ms) => ms >= 60_000)).toBe(true)
    expect(invitations).toHaveLength(1)
  })

  it("leaves a target deferred when the retry cap is exhausted", async () => {
    // Throttled on every attempt; maxRetries: 1 runs one retry round that also
    // 429s, so the target ends in `deferred` (never failed), invited zero times.
    const { client, invitations } = makeInviteClient({ rateLimitFromInvite: 0 })
    const slept: number[] = []

    const res = await inviteRosterStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [{ username: "a", github_id: "1" }],
      maxRetries: 1,
      sleepFn: async (ms) => {
        slept.push(ms)
      },
    })

    expect(res.deferred).toEqual(["a"])
    expect(res.failed).toEqual([])
    expect(res.invited).toEqual([])
    expect(slept).toHaveLength(1) // one retry round, then the cap hit
    expect(invitations).toEqual([])
  })

  it("routes a non-rate-limit error during a retry round to failed", async () => {
    // First attempt 429s (deferred); the retry attempt falls through to the
    // generic invitationFails path (a 500-like error) -> failed, not deferred.
    const { client, invitations } = makeInviteClient({
      rateLimitFirstN: 1,
      invitationFails: true,
    })

    const res = await inviteRosterStudents(client, {
      org: "acme",
      classroom: "cs101",
      students: [{ username: "a", github_id: "1" }],
      sleepFn: async () => {},
    })

    expect(res.failed).toHaveLength(1)
    expect(res.failed[0]?.username).toBe("a")
    expect(res.deferred).toEqual([])
    expect(res.invited).toEqual([])
    expect(invitations).toEqual([])
  })
})

describe("migrateRosterFile — converge students.csv onto roster.csv", () => {
  // A minimal client: contents reads for roster.csv/students.csv (present in
  // `files`, else a real 404), plus the git-data write surface. Records the
  // tree payload so a test can assert the upsert + delete.
  const notFound = (path: string) =>
    new GitHubAPIError({
      status: 404,
      url: path,
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

  const makeMigrateClient = (files: Record<string, string>) => {
    const committed: {
      tree: { path: string; content?: string; sha?: string | null }[] | null
    } = { tree: null }
    let treePosted = false

    const request = vi
      .fn()
      .mockImplementation((path: string, options?: { body?: unknown }) => {
        if (/\/repos\/[^/]+\/classroom50$/.test(path))
          return { default_branch: "main" }
        if (path.includes("/contents/")) {
          const match = path.match(/\/contents\/(.+?)(\?|$)/)
          const rel = match ? decodeURIComponent(match[1]) : ""
          const content = files[rel]
          if (content == null) return Promise.reject(notFound(path))
          return Promise.resolve({
            type: "file",
            encoding: "base64",
            content: Buffer.from(content, "utf-8").toString("base64"),
          })
        }
        if (path.includes("/git/ref/")) {
          return Promise.resolve({ object: { sha: "base-sha" } })
        }
        if (path.includes("/git/commits/")) {
          return Promise.resolve({ tree: { sha: "base-tree-sha" } })
        }
        if (path.endsWith("/git/trees")) {
          treePosted = true
          committed.tree =
            (
              options?.body as {
                tree?: {
                  path: string
                  content?: string
                  sha?: string | null
                }[]
              }
            )?.tree ?? null
          return Promise.resolve({ sha: "tree-sha" })
        }
        if (path.endsWith("/git/commits")) {
          return Promise.resolve({ sha: "new-commit-sha" })
        }
        if (path.endsWith("/git/refs/heads/main")) {
          return Promise.resolve({})
        }
        return Promise.reject(new Error(`unexpected request: ${path}`))
      })

    return {
      client: { request } as unknown as GitHubClient,
      committed,
      treePosted: () => treePosted,
    }
  }

  const LEGACY =
    "username,first_name,last_name,email,section,github_id,role\nada,,,,,1,student\n"

  it("renames students.csv to roster.csv (write new + delete legacy) in one commit", async () => {
    const { client, committed } = makeMigrateClient({
      "cs101/students.csv": LEGACY,
    })

    const result = await migrateRosterFile(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.migrated).toBe(true)
    const upsert = committed.tree?.find((t) => t.path === "cs101/roster.csv")
    expect(upsert?.content).toBe(LEGACY) // legacy bytes verbatim
    const del = committed.tree?.find((t) => t.path === "cs101/students.csv")
    expect(del?.sha).toBeNull() // deletion
  })

  it("is a no-op when roster.csv already exists", async () => {
    const { client, treePosted } = makeMigrateClient({
      "cs101/roster.csv": LEGACY,
    })

    const result = await migrateRosterFile(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.migrated).toBe(false)
    expect(treePosted()).toBe(false)
  })

  it("prefers the existing roster.csv when both files are present (no rename)", async () => {
    const { client, treePosted } = makeMigrateClient({
      "cs101/roster.csv": LEGACY,
      "cs101/students.csv": LEGACY,
    })

    const result = await migrateRosterFile(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.migrated).toBe(false)
    expect(treePosted()).toBe(false)
  })

  it("does nothing when neither file exists (brand-new classroom)", async () => {
    const { client, treePosted } = makeMigrateClient({})

    const result = await migrateRosterFile(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.migrated).toBe(false)
    expect(treePosted()).toBe(false)
  })
})

describe("assignRosterMemberRole — enroll a rostered active member", () => {
  it("adds an active org member to the student team and reports assigned", async () => {
    const { client, teamAdds } = makeTeamClient({
      startingCsv: HEADER,
      users: { wanda: { id: 50 } },
      members: ["wanda"], // wanda is an active org member, on no team yet
    })

    const result = await assignRosterMemberRole(client, {
      org: "acme",
      classroom: "cs101",
      username: "wanda",
      role: "student",
    })

    expect(result).toEqual({ state: "assigned", role: "student" })
    // Added to the derived classroom student team.
    expect(teamAdds).toEqual(["wanda"])
  })

  it("never team-adds a non-member — reports not-member for the invite path", async () => {
    const { client, teamAdds } = makeTeamClient({
      startingCsv: HEADER,
      users: { stranger: { id: 77 } },
      members: [], // not an active org member
    })

    const result = await assignRosterMemberRole(client, {
      org: "acme",
      classroom: "cs101",
      username: "stranger",
      role: "student",
    })

    expect(result).toEqual({ state: "not-member" })
    expect(teamAdds).toEqual([])
  })

  it("surfaces a transient membership-read failure instead of misreporting not-member", async () => {
    const { client, request, teamAdds } = makeTeamClient({
      startingCsv: HEADER,
      users: { wanda: { id: 50 } },
      members: ["wanda"],
    })
    // Make the membership read fail transiently (500), not a definitive 404.
    request.mockImplementationOnce((path: string) => {
      if (path.includes("/memberships/") && !path.includes("/teams/")) {
        return Promise.reject(
          new GitHubAPIError({
            status: 500,
            url: path,
            message: "boom",
            body: null,
            rateLimit: {
              limit: null,
              remaining: null,
              used: null,
              reset: null,
              resource: null,
              retryAfter: null,
            },
          }),
        )
      }
      return Promise.reject(new Error(`unexpected: ${path}`))
    })

    await expect(
      assignRosterMemberRole(client, {
        org: "acme",
        classroom: "cs101",
        username: "wanda",
        role: "student",
      }),
    ).rejects.toThrow(/boom/)
    // Never team-added on an unknown membership picture.
    expect(teamAdds).toEqual([])
  })
})

// A focused client mock for applyRosterRoleChange: records team adds, team
// removes, org-membership role PUTs, and an ordered `ops` log (to assert the
// owner-demote-first ordering). `members` are active org members; anyone else
// 404s. `failRemoveSlug` makes a team-removal of that slug throw (best-effort
// warning path).
const makeRoleChangeClient = (opts: {
  members: string[]
  failRemoveSlug?: string
  // The authenticated viewer's login (GET /user) — drives the self-demote
  // guard. Defaults to a bystander so existing demotion tests don't self-demote.
  viewerLogin?: string
  // Logins the org reports as owners (GET /members?role=admin) — drives the
  // sole-owner guard. Defaults to two owners so a demotion isn't blocked.
  admins?: string[]
  // Make the team-add step throw (to exercise the post-demote failure path).
  failTeamAdd?: boolean
}) => {
  const memberSet = new Set(opts.members.map((m) => m.toLowerCase()))
  const teamAdds: { slug: string; login: string }[] = []
  const teamRemoves: { slug: string; login: string }[] = []
  const orgRolePuts: { login: string; role: string }[] = []
  const ops: (
    | { kind: "orgRole"; login: string; role: string }
    | { kind: "teamAdd"; slug: string; login: string }
    | { kind: "teamRemove"; slug: string; login: string }
  )[] = []
  const viewerLogin = opts.viewerLogin ?? "someviewer"
  const admins = opts.admins ?? ["owner-a", "owner-b"]

  const requestRaw = vi.fn().mockImplementation((path: string) => {
    if (path.includes("/contents/") && path.includes("classroom.json")) {
      return Promise.resolve(JSON.stringify({ short_name: "cs101" }))
    }
    return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
  })

  const request = vi
    .fn()
    .mockImplementation(
      (path: string, options?: { method?: string; body?: unknown }) => {
        const method = options?.method ?? "GET"
        if (/\/repos\/[^/]+\/classroom50$/.test(path))
          return { default_branch: "main" }
        // Authenticated viewer (getAuthenticatedUser) for the self-demote guard.
        if (path === "/user") {
          return Promise.resolve({ id: 1, login: viewerLogin })
        }
        // Org owners (listOrgAdmins) for the sole-owner guard.
        if (path.includes("/members") && path.includes("role=admin")) {
          return Promise.resolve(
            admins.map((login, i) => ({ id: 100 + i, login })),
          )
        }
        // classroom.json read (resolveClassroomTeamSlugs) -> derived slugs.
        if (path.includes("/contents/") && path.includes("classroom.json")) {
          return Promise.reject(
            new GitHubAPIError({
              status: 404,
              url: path,
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
            }),
          )
        }
        // Create team (ensureSecretTeamByName): POST /orgs/{org}/teams
        if (path.endsWith("/teams") && method === "POST") {
          const name = (options?.body as { name?: string })?.name ?? ""
          return Promise.resolve({ id: 999, slug: name, name })
        }
        // Ensure staff team (GET/adopt team by name) -> resolve an adopted team.
        if (path.includes("/teams/") && !path.includes("/memberships/")) {
          const slugMatch = path.match(/\/teams\/([^/]+)/)
          const slug = slugMatch ? decodeURIComponent(slugMatch[1]) : ""
          // Team-remove: DELETE .../teams/{slug}/memberships handled below.
          return Promise.resolve({ id: 999, slug, name: slug })
        }
        // Grant config-repo write: PUT /orgs/{org}/teams/{slug}/repos/... — the
        // team-repo path also matches /teams/ above; disambiguate by /repos/.
        // (Handled by the /teams/ branch returning a benign object.)
        // Team membership PUT/DELETE: .../teams/{slug}/memberships/{login}
        if (path.includes("/teams/") && path.includes("/memberships/")) {
          const parts = path.split("/teams/")[1]
          const slug = decodeURIComponent(parts.split("/memberships/")[0])
          const login = decodeURIComponent(parts.split("/memberships/")[1])
          if (method === "DELETE") {
            if (opts.failRemoveSlug && slug === opts.failRemoveSlug) {
              return Promise.reject(new Error(`remove failed: ${slug}`))
            }
            teamRemoves.push({ slug, login })
            ops.push({ kind: "teamRemove", slug, login })
            return Promise.resolve()
          }
          if (opts.failTeamAdd) {
            return Promise.reject(new Error(`team add failed: ${slug}`))
          }
          teamAdds.push({ slug, login })
          ops.push({ kind: "teamAdd", slug, login })
          return Promise.resolve({ state: "active" })
        }
        // Org membership: GET returns state; PUT sets role.
        if (path.includes("/memberships/") && !path.includes("/teams/")) {
          const login = decodeURIComponent(path.split("/memberships/")[1])
          if (method === "PUT") {
            const role = (options?.body as { role?: string })?.role ?? ""
            orgRolePuts.push({ login, role })
            ops.push({ kind: "orgRole", login, role })
            return Promise.resolve({ state: "active", role })
          }
          if (memberSet.has(login.toLowerCase())) {
            return Promise.resolve({ state: "active" })
          }
          return Promise.reject(
            new GitHubAPIError({
              status: 404,
              url: path,
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
            }),
          )
        }
        // Add repo to team (grantTeamConfigRepoWrite): PUT
        // /orgs/{org}/teams/{slug}/repos/{owner}/{repo}
        if (path.includes("/repos/")) {
          return Promise.resolve()
        }
        return Promise.reject(new Error(`unexpected request: ${path}`))
      },
    )

  return {
    client: { request, requestRaw } as unknown as GitHubClient,
    teamAdds,
    teamRemoves,
    orgRolePuts,
    ops,
  }
}

describe("applyRosterRoleChange — confirmed team move / enroll", () => {
  it("moves a student to TA: adds to the ta team, removes from the student team", async () => {
    const { client, teamAdds, teamRemoves, orgRolePuts } = makeRoleChangeClient(
      { members: ["userb"] },
    )

    const result = await applyRosterRoleChange(client, {
      org: "acme",
      classroom: "cs101",
      username: "userb",
      fromRoles: ["student"],
      toRole: "ta",
    })

    expect(result.warnings).toEqual([])
    expect(teamAdds).toContainEqual({
      slug: "classroom50-cs101-ta",
      login: "userb",
    })
    expect(teamRemoves).toContainEqual({
      slug: "classroom50-cs101",
      login: "userb",
    })
    // Not an instructor move, so no org-owner promotion.
    expect(orgRolePuts).toEqual([])
  })

  it("promotes to instructor: adds to the instructor team AND sets org role admin", async () => {
    const { client, teamAdds, orgRolePuts } = makeRoleChangeClient({
      members: ["userb"],
    })

    await applyRosterRoleChange(client, {
      org: "acme",
      classroom: "cs101",
      username: "userb",
      fromRoles: ["student"],
      toRole: "instructor",
    })

    expect(teamAdds).toContainEqual({
      slug: "classroom50-cs101-instructor",
      login: "userb",
    })
    expect(orgRolePuts).toContainEqual({ login: "userb", role: "admin" })
  })

  it("downgrades an instructor to student: demotes org role to member BEFORE any team change", async () => {
    const { client, teamAdds, teamRemoves, orgRolePuts, ops } =
      makeRoleChangeClient({ members: ["boss"] })

    await applyRosterRoleChange(client, {
      org: "acme",
      classroom: "cs101",
      username: "boss",
      fromRoles: ["instructor"],
      toRole: "student",
    })

    expect(teamAdds).toContainEqual({
      slug: "classroom50-cs101",
      login: "boss",
    })
    expect(teamRemoves).toContainEqual({
      slug: "classroom50-cs101-instructor",
      login: "boss",
    })
    expect(orgRolePuts).toContainEqual({ login: "boss", role: "member" })
    // The owner demote must run FIRST, so a failure never leaves the member
    // half-moved-but-still-owner. The first recorded op is the membership PUT.
    expect(ops[0]).toEqual({ kind: "orgRole", login: "boss", role: "member" })
  })

  it("drops EVERY non-target classroom team for a multi-team member", async () => {
    const { client, teamRemoves } = makeRoleChangeClient({ members: ["boss"] })

    // On both instructor + ta; move to student -> both staff teams dropped.
    await applyRosterRoleChange(client, {
      org: "acme",
      classroom: "cs101",
      username: "boss",
      fromRoles: ["ta", "instructor"],
      toRole: "student",
    })

    expect(teamRemoves).toContainEqual({
      slug: "classroom50-cs101-instructor",
      login: "boss",
    })
    expect(teamRemoves).toContainEqual({
      slug: "classroom50-cs101-ta",
      login: "boss",
    })
  })

  it("enroll (empty fromRoles): adds to the target team and drops nothing", async () => {
    const { client, teamAdds, teamRemoves, orgRolePuts } = makeRoleChangeClient(
      { members: ["newta"] },
    )

    await applyRosterRoleChange(client, {
      org: "acme",
      classroom: "cs101",
      username: "newta",
      fromRoles: [],
      toRole: "ta",
    })

    expect(teamAdds).toContainEqual({
      slug: "classroom50-cs101-ta",
      login: "newta",
    })
    expect(teamRemoves).toEqual([])
    expect(orgRolePuts).toEqual([]) // ta target, not instructor
  })

  it("surfaces a warning (not a throw) when the old-team removal fails", async () => {
    const { client, teamAdds } = makeRoleChangeClient({
      members: ["userb"],
      failRemoveSlug: "classroom50-cs101",
    })

    const result = await applyRosterRoleChange(client, {
      org: "acme",
      classroom: "cs101",
      username: "userb",
      fromRoles: ["student"],
      toRole: "ta",
    })

    // Target add still landed; the failed removal is a warning, not fatal.
    expect(teamAdds).toContainEqual({
      slug: "classroom50-cs101-ta",
      login: "userb",
    })
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]).toMatch(/removing them from/)
  })

  it("throws for a non-member (never team-adds) so the caller routes to invite", async () => {
    const { client, teamAdds } = makeRoleChangeClient({ members: [] })

    await expect(
      applyRosterRoleChange(client, {
        org: "acme",
        classroom: "cs101",
        username: "stranger",
        fromRoles: ["student"],
        toRole: "ta",
      }),
    ).rejects.toThrow(/not an active member/)
    expect(teamAdds).toEqual([])
  })

  it("refuses a self-demotion off instructor before any mutation", async () => {
    const { client, orgRolePuts, teamAdds } = makeRoleChangeClient({
      members: ["boss"],
      viewerLogin: "boss", // the acting owner IS the demotion target
    })

    await expect(
      applyRosterRoleChange(client, {
        org: "acme",
        classroom: "cs101",
        username: "boss",
        fromRoles: ["instructor"],
        toRole: "student",
      }),
    ).rejects.toThrow(/can't demote yourself/i)
    // Nothing mutated — the guard runs before the owner demote and team moves.
    expect(orgRolePuts).toEqual([])
    expect(teamAdds).toEqual([])
  })

  it("refuses demoting the sole organization owner", async () => {
    const { client, orgRolePuts } = makeRoleChangeClient({
      members: ["boss"],
      viewerLogin: "someviewer",
      admins: ["boss"], // boss is the only owner
    })

    await expect(
      applyRosterRoleChange(client, {
        org: "acme",
        classroom: "cs101",
        username: "boss",
        fromRoles: ["instructor"],
        toRole: "student",
      }),
    ).rejects.toThrow(/only organization owner/i)
    expect(orgRolePuts).toEqual([])
  })

  it("does not block a demotion when the owner list is unreadable (403 -> [])", async () => {
    // admins:[] models listOrgAdmins' 403 fallback; the guard must NOT block
    // (fail-open), so the demotion proceeds normally.
    const { client, orgRolePuts } = makeRoleChangeClient({
      members: ["boss"],
      admins: [],
    })

    await applyRosterRoleChange(client, {
      org: "acme",
      classroom: "cs101",
      username: "boss",
      fromRoles: ["instructor"],
      toRole: "student",
    })

    expect(orgRolePuts).toContainEqual({ login: "boss", role: "member" })
  })

  it("surfaces an owner-revoked error when a step fails after the demote", async () => {
    // The owner demote commits, then the target team-add throws — the error
    // must say the owner was revoked so the caller re-runs, not a generic fail.
    const { client, orgRolePuts } = makeRoleChangeClient({
      members: ["boss"],
      failTeamAdd: true,
    })

    await expect(
      applyRosterRoleChange(client, {
        org: "acme",
        classroom: "cs101",
        username: "boss",
        fromRoles: ["instructor"],
        toRole: "student",
      }),
    ).rejects.toThrow(/demoted from organization owner.*Re-run/s)
    // The demote did land (it ran first); the failure is the team move.
    expect(orgRolePuts).toContainEqual({ login: "boss", role: "member" })
  })
})

describe("resolveTeamIdForRoleRead — read-only team id per role", () => {
  const notFound = (path: string) =>
    new GitHubAPIError({
      status: 404,
      url: path,
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

  // classroom.json read via requestRaw; `json` null models a 404 (no file).
  const makeClient = (json: Record<string, unknown> | null) => {
    const requestRaw = vi.fn().mockImplementation((path: string) => {
      if (path.includes("classroom.json")) {
        return json === null
          ? Promise.reject(notFound(path))
          : Promise.resolve(JSON.stringify(json))
      }
      return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
    })
    return { requestRaw } as unknown as GitHubClient
  }

  it("student -> the classroom team id from classroom.json.team", async () => {
    const client = makeClient({ team: { slug: "classroom50-cs101", id: 4242 } })
    expect(
      await resolveTeamIdForRoleRead(client, "acme", "cs101", "student"),
    ).toBe(4242)
  })

  it("staff -> the role's team id from classroom.json.teams[role]", async () => {
    const client = makeClient({
      teams: { instructor: { id: 7 }, ta: { id: 9 } },
    })
    expect(
      await resolveTeamIdForRoleRead(client, "acme", "cs101", "instructor"),
    ).toBe(7)
    expect(await resolveTeamIdForRoleRead(client, "acme", "cs101", "ta")).toBe(
      9,
    )
  })

  it("staff with no teams block -> undefined (no team to attach)", async () => {
    const client = makeClient({ team: { slug: "classroom50-cs101", id: 1 } })
    expect(
      await resolveTeamIdForRoleRead(client, "acme", "cs101", "instructor"),
    ).toBeUndefined()
  })

  it("staff, classroom.json 404 -> undefined (not a throw)", async () => {
    const client = makeClient(null)
    expect(
      await resolveTeamIdForRoleRead(client, "acme", "cs101", "ta"),
    ).toBeUndefined()
  })
})
