import { describe, expect, it, vi } from "vitest"
import Papa from "papaparse"

import {
  enrollStudentInClassroom,
  inviteByEmail,
  unenrollStudent,
  bulkUnenrollStudents,
  bulkEnrollStudentsInClassroom,
  reconcileTeamFromOrgMembers,
  inviteRosterStudents,
  syncRosterFromTeam,
  migrateRosterFile,
  updateStudent,
  updateStudentWithConflictRetry,
  parseStudentsCsv,
  STUDENT_CSV_FIELDS,
  StudentAlreadyEnrolledError,
} from "./students"
import { GitHubAPIError } from "@/hooks/github/errors"
import type { GitHubClient } from "@/hooks/github/client"

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
}) => {
  const committed: CommittedCsv = { content: null }
  const membershipState = opts.membershipState ?? null

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
          options?.body as { tree?: { path: string; content?: string }[] }
        )?.tree
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
      if (path.includes("/invitations")) {
        return Promise.resolve({})
      }
      if (path.includes("/teams/")) {
        return Promise.resolve({ state: "active" })
      }
      return Promise.reject(new Error(`unexpected request: ${path}`))
    })

  const client = { request, requestRaw } as unknown as GitHubClient
  return { client, committed }
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
  it("writes the roster blob at <classroom>/roster.csv", async () => {
    const treePaths: string[] = []
    const requestRaw = vi.fn().mockImplementation((path: string) => {
      if (path.includes("/contents/") && path.includes("classroom.json")) {
        return Promise.resolve(JSON.stringify({ short_name: "cs101" }))
      }
      return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
    })
    const request = vi
      .fn()
      .mockImplementation((path: string, options?: { body?: unknown }) => {
        // The write target is always roster.csv; the read may fall back to the
        // legacy students.csv (covered separately below), but here roster.csv
        // exists so no fallback fires.
        if (path.includes("/contents/") && path.includes("roster.csv")) {
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
        if (path.endsWith("/git/trees")) {
          const tree = (options?.body as { tree?: { path: string }[] })?.tree
          for (const t of tree ?? []) treePaths.push(t.path)
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

    expect(treePaths).toContain("cs101/roster.csv")
    expect(treePaths).not.toContain("cs101/students.csv")
  })

  // A classroom bootstrapped before the students.csv -> roster.csv rename has
  // only students.csv on disk. The read-modify-write mutations must fall back to
  // the legacy file on a roster.csv 404 (mirroring the display readers) so the
  // roster stays editable from the web before `gh teacher roster migrate` runs;
  // the write still converges onto roster.csv.
  it("reads the legacy students.csv when roster.csv is absent, still writing roster.csv", async () => {
    const treePaths: string[] = []
    const requestRaw = vi.fn().mockImplementation((path: string) => {
      if (path.includes("/contents/") && path.includes("classroom.json")) {
        return Promise.resolve(JSON.stringify({ short_name: "cs101" }))
      }
      return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
    })
    const request = vi
      .fn()
      .mockImplementation((path: string, options?: { body?: unknown }) => {
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
        if (path.endsWith("/git/trees")) {
          const tree = (options?.body as { tree?: { path: string }[] })?.tree
          for (const t of tree ?? []) treePaths.push(t.path)
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

    // The write converges onto roster.csv even though the read came from legacy.
    expect(treePaths).toContain("cs101/roster.csv")
    expect(treePaths).not.toContain("cs101/students.csv")
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
describe("unenrollStudent — classroom-scoped, no active-member org removal", () => {
  const aliceEnrolled = "alice,Alice,A,alice@x.edu,,42\n"
  const bobInvited = "bob,Bob,B,bob@x.edu,,43\n"

  const makeUnenrollClient = (opts: {
    startingCsv: string
    membershipState?: "active" | "pending" | null
    viewer?: { login: string; id: number }
  }) => {
    const committed: { content: string | null } = { content: null }
    const membershipState = opts.membershipState ?? null
    const orgMembershipDeletes: string[] = []

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
    return { client, committed, orgMembershipDeletes }
  }

  it("removes the roster row but never removes an ACTIVE org member", async () => {
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

    const rows = rowsFromCsv(committed.content!)
    expect(rows.find((r) => r.username === "alice")).toBeUndefined()
    // No org-membership DELETE for an active member.
    expect(orgMembershipDeletes).toHaveLength(0)
  })

  it("cancels a PENDING invite on unenroll", async () => {
    const { client, committed, orgMembershipDeletes } = makeUnenrollClient({
      startingCsv: HEADER + bobInvited,
      membershipState: "pending",
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
    // The pending invite is cancelled via the memberships DELETE.
    expect(orgMembershipDeletes).toHaveLength(1)
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
    const { client, orgMembershipDeletes } = makeUnenrollClient({
      startingCsv: HEADER + bobInvited,
      membershipState: "pending",
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

    // Self: invite NOT cancelled, and a warning explains why.
    expect(orgMembershipDeletes).toHaveLength(0)
    expect(result.teamWarning).toMatch(/signed-in account/i)
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
// classroom team. Drives bulkEnrollStudentsInClassroom / reconcileTeamFromOrgMembers
// / syncRosterFromTeam end to end (CSV read+commit, /users/{login}, membership
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
        return Promise.reject(new Error("404 not a member"))
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
  }
}

describe("bulkEnrollStudentsInClassroom — verify org membership, flag non-members", () => {
  it("adds active org members to the team and flags non-members as notInOrg", async () => {
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
    // ...but only the active member is team-added; the non-member is flagged.
    expect(teamAdds).toEqual(["ada"])
    expect(result.notInOrg).toEqual(["bob"])
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

describe("reconcileTeamFromOrgMembers — verified, best-effort team-add", () => {
  it("adds active members and skips a rostered non-member (stays not_in_org)", async () => {
    const { client, teamAdds } = makeTeamClient({
      startingCsv: HEADER,
      users: { ada: { id: 101 }, gone: { id: 999 } },
      members: ["ada"], // "gone" is not an active org member
    })

    const result = await reconcileTeamFromOrgMembers(client, {
      org: "acme",
      classroom: "cs101",
      usernames: ["ada", "gone"],
    })

    expect(result.added).toEqual(["ada"])
    expect(teamAdds).toEqual(["ada"])
    // A non-member isn't a failure — it's skipped and stays highlighted.
    expect(result.skipped).toEqual(["gone"])
    expect(result.failed).toEqual([])
  })

  it("short-circuits with no usernames", async () => {
    const { client, teamAdds } = makeTeamClient({
      startingCsv: HEADER,
      users: {},
    })
    const result = await reconcileTeamFromOrgMembers(client, {
      org: "acme",
      classroom: "cs101",
      usernames: [],
    })
    expect(result).toEqual({ added: [], skipped: [], failed: [] })
    expect(teamAdds).toEqual([])
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
        if (opts.invitationFails) {
          return Promise.reject(new Error("invite blew up"))
        }
        const body = (options as { body?: { invitee_id?: number } }).body
        invitations.push(body ?? {})
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

    expect(res.invited).toEqual(["octocat"])
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

    expect(res.invited).toEqual(["torvalds"])
    expect(invitations).toEqual([{ invitee_id: 2, role: "direct_member" }])
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
