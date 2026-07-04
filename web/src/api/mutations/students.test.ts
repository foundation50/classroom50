import { describe, expect, it, vi } from "vitest"
import Papa from "papaparse"

import {
  enrollStudentInClassroom,
  inviteStudentByEmail,
  markStudentEnrolledWithConflictRetry,
  matchStudentToAccountWithConflictRetry,
  reconcileOnboarding,
  unenrollStudent,
  updateStudent,
  updateStudentWithConflictRetry,
} from "./students"
import { GitHubAPIError } from "@/hooks/github/errors"
import type { GitHubClient } from "@/hooks/github/client"
import { emailHash } from "@/util/onboarding"

// An already-org-member must land `enrolled` (not stuck "awaiting"), the
// per-row confirm must refuse a non-member, and an already-member email invite
// must resolve cross-roster or drop the stub. I/O is stubbed via a path-routing
// fake client; assertions read the students.csv committed to git/trees.

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
      if (path.includes("/contents/") && path.includes("students.csv")) {
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
        const csvEntry = tree?.find((t) => t.path.includes("students.csv"))
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

const HEADER =
  "username,first_name,last_name,email,section,github_id,enrollment_status,enrollment_method,email_hash,invite_token,invited_at,enrolled_at\n"

const rowsFromCsv = (csv: string) =>
  Papa.parse(csv, { header: true, skipEmptyLines: true }).data as Record<
    string,
    string
  >[]

describe("enrollStudentInClassroom — already-member writes enrolled directly", () => {
  it("writes enrollment_status 'enrolled' + enrolled_at when the user is already an active org member", async () => {
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
    expect(alice?.enrollment_status).toBe("enrolled")
    expect(alice?.enrolled_at).toBeTruthy()
  })

  it("writes 'invited' (not enrolled) when the user is not yet a member", async () => {
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
    expect(bob?.enrollment_status).toBe("invited")
    expect(bob?.enrolled_at).toBeFalsy()
  })
})

describe("markStudentEnrolledWithConflictRetry — member-guarded manual confirm", () => {
  const invitedRow =
    "alice,Alice,A,alice@x.edu,,42,invited,github,,tok-1,2026-01-01T00:00:00Z,\n"

  it("refuses to mark a non-member enrolled (guard throws, no write)", async () => {
    const { client, committed } = makeClient({
      startingCsv: HEADER + invitedRow,
      membershipState: null, // not a member
    })

    await expect(
      markStudentEnrolledWithConflictRetry(client, {
        org: "acme",
        classroom: "cs101",
        username: "alice",
        github_id: "42",
      }),
    ).rejects.toThrow(/not an active member/i)
    expect(committed.content).toBeNull()
  })

  it("writes enrolled + enrolled_at for a verified active member", async () => {
    const { client, committed } = makeClient({
      startingCsv: HEADER + invitedRow,
      membershipState: "active",
    })

    const result = await markStudentEnrolledWithConflictRetry(client, {
      org: "acme",
      classroom: "cs101",
      username: "alice",
      github_id: "42",
    })

    expect(result.alreadyEnrolled).toBe(false)
    const rows = rowsFromCsv(committed.content!)
    const alice = rows.find((r) => r.username === "alice")
    expect(alice?.enrollment_status).toBe("enrolled")
    expect(alice?.enrolled_at).toBeTruthy()
    expect(alice?.email).toBe("alice@x.edu")
    expect(alice?.github_id).toBe("42")
  })

  it("throws when the row does not exist", async () => {
    const { client } = makeClient({
      startingCsv: HEADER,
      membershipState: "active",
    })

    await expect(
      markStudentEnrolledWithConflictRetry(client, {
        org: "acme",
        classroom: "cs101",
        username: "ghost",
        github_id: "999",
      }),
    ).rejects.toThrow(/does not exist in roster/i)
  })
})

describe("inviteStudentByEmail — already-member email resolution (email path)", () => {
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

  // Fake client over a mutable multi-classroom roster map. inviteSucceeds=false
  // makes POST /invitations 422 (the already-member signal).
  const makeEmailClient = (opts: {
    rosters: Record<string, string>
    inviteSucceeds: boolean
    membershipState?: "active" | "pending" | null
    // github_id -> current login (GET /user/{id}); the 422 already-member path
    // derives the fresh login from the resolved id before binding.
    usersById?: Record<string, string>
  }) => {
    const rosters = { ...opts.rosters }
    const membershipState = opts.membershipState ?? "active"
    const usersById = opts.usersById ?? {}

    const csvFileResponse = (csv: string) => ({
      type: "file" as const,
      encoding: "base64" as const,
      content: Buffer.from(csv, "utf-8").toString("base64"),
    })

    const classroomOf = (path: string) => {
      const m = path.match(/\/contents\/([^/]+)\/students\.csv/)
      return m ? decodeURIComponent(m[1]) : null
    }

    // Track which classroom's csv the last git tree write targeted.
    let pendingWriteClassroom: string | null = null

    const requestRaw = vi.fn().mockImplementation((path: string) => {
      if (/\/contents\/(\?|$)/.test(path) || path.endsWith("/contents/")) {
        // listClassroomDirs: repo-root contents as a dir listing.
        const dirs = Object.keys(rosters).map((name) => ({
          type: "dir",
          name,
          path: name,
        }))
        return Promise.resolve(JSON.stringify(dirs))
      }
      if (path.includes("classroom.json")) {
        return Promise.resolve(JSON.stringify({ short_name: "x" }))
      }
      return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
    })

    const request = vi
      .fn()
      .mockImplementation(
        (path: string, options?: { method?: string; body?: unknown }) => {
          if (path.includes("/contents/") && path.includes("students.csv")) {
            const cls = classroomOf(path)
            const csv = (cls && rosters[cls]) ?? HEADER
            return Promise.resolve(csvFileResponse(csv))
          }
          if (path.includes("/memberships/") && !path.includes("/teams/")) {
            if (membershipState === null) {
              return Promise.reject(new Error("404"))
            }
            return Promise.resolve({ state: membershipState })
          }
          const userByIdMatch = path.match(/\/user\/(\d+)$/)
          if (userByIdMatch) {
            const login = usersById[userByIdMatch[1]]
            if (!login) return Promise.reject(new Error("404 no such user"))
            return Promise.resolve({ login, id: Number(userByIdMatch[1]) })
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
            const csvEntry = tree?.find((t) => t.path.includes("students.csv"))
            if (csvEntry) {
              const m = csvEntry.path.match(/^([^/]+)\/students\.csv/)
              pendingWriteClassroom = m ? m[1] : null
              if (pendingWriteClassroom && csvEntry.content != null) {
                rosters[pendingWriteClassroom] = csvEntry.content
              }
            }
            return Promise.resolve({ sha: "tree-sha" })
          }
          if (path.endsWith("/git/commits")) {
            return Promise.resolve({ sha: "new-commit-sha" })
          }
          if (path.endsWith("/git/refs/heads/main")) {
            return Promise.resolve({})
          }
          if (path.endsWith("/invitations")) {
            if (opts.inviteSucceeds) return Promise.resolve({})
            return Promise.reject(apiError422())
          }
          if (path.includes("/teams/")) {
            return Promise.resolve({ state: "active" })
          }
          return Promise.reject(new Error(`unexpected request: ${path}`))
        },
      )

    return {
      client: { request, requestRaw } as unknown as GitHubClient,
      rosters,
    }
  }

  const enrolledRowFor = async (
    email: string,
    username: string,
    id: string,
    firstName = "",
    lastName = "",
  ) => {
    const hash = await emailHash(email)
    return `${username},${firstName},${lastName},${email},sec-other,${id},enrolled,github,${hash},,2026-01-01T00:00:00Z,2026-01-02T00:00:00Z\n`
  }

  it("invite succeeds for a new email -> row stays invited", async () => {
    const { client, rosters } = makeEmailClient({
      rosters: { cs101: HEADER },
      inviteSucceeds: true,
    })

    const result = await inviteStudentByEmail(client, {
      org: "acme",
      classroom: "cs101",
      email: "new@x.edu",
    })

    expect(result.inviteWarning).toBeUndefined()
    const rows = rowsFromCsv(rosters.cs101)
    expect(rows.find((r) => r.email === "new@x.edu")?.enrollment_status).toBe(
      "invited",
    )
  })

  it("422 + email enrolled in another classroom -> enrolled here, name backfilled, section not copied", async () => {
    const otherRoster =
      HEADER +
      (await enrolledRowFor("dup@x.edu", "carol-old", "77", "Carol", "Diaz"))
    const { client, rosters } = makeEmailClient({
      rosters: { cs101: HEADER, cs202: otherRoster },
      inviteSucceeds: false, // already a member -> 422
      membershipState: "active",
      // Stored username "carol-old" is stale; the id derives the current login.
      usersById: { "77": "carol" },
    })

    const result = await inviteStudentByEmail(client, {
      org: "acme",
      classroom: "cs101",
      email: "dup@x.edu",
    })

    const rows = rowsFromCsv(rosters.cs101)
    const row = rows.find((r) => r.email === "dup@x.edu")
    expect(row?.enrollment_status).toBe("enrolled")
    // Fresh login derived from id 77, not the stale stored "carol-old".
    expect(row?.username).toBe("carol")
    expect(row?.github_id).toBe("77")
    expect(row?.first_name).toBe("Carol")
    expect(row?.last_name).toBe("Diaz")
    expect(row?.section ?? "").not.toBe("sec-other")
    expect(result.student.enrollment_status).toBe("enrolled")
  })

  it("teacher-entered name wins over the other classroom's name on backfill", async () => {
    const otherRoster =
      HEADER + (await enrolledRowFor("dup2@x.edu", "dave", "88", "Old", "Name"))
    const { client, rosters } = makeEmailClient({
      rosters: { cs101: HEADER, cs202: otherRoster },
      inviteSucceeds: false,
      membershipState: "active",
    })

    await inviteStudentByEmail(client, {
      org: "acme",
      classroom: "cs101",
      email: "dup2@x.edu",
      first_name: "Teacher",
      last_name: "Typed",
    })

    const row = rowsFromCsv(rosters.cs101).find((r) => r.email === "dup2@x.edu")
    expect(row?.first_name).toBe("Teacher")
    expect(row?.last_name).toBe("Typed")
  })

  it("422 + email NOT in any other roster -> row PERSISTS for manual matching + warning", async () => {
    const { client, rosters } = makeEmailClient({
      rosters: { cs101: HEADER, cs202: HEADER },
      inviteSucceeds: false, // already a member -> 422
    })

    const result = await inviteStudentByEmail(client, {
      org: "acme",
      classroom: "cs101",
      email: "ghost@x.edu",
    })

    expect(result.inviteWarning).toMatch(/already belongs to a member/i)
    expect(result.inviteWarning).toMatch(/match account|remove the row/i)
    // The invited email row is KEPT so the teacher can match or delete it.
    const rows = rowsFromCsv(rosters.cs101)
    const ghost = rows.find((r) => r.email === "ghost@x.edu")
    expect(ghost).toBeTruthy()
    expect(ghost?.enrollment_status).toBe("invited")
    expect(ghost?.username).toBe("")
  })
})

describe("updateStudent — edit a roster row's teacher-facing fields in place", () => {
  // alice: enrolled github row (identity by github_id 42); bob: email-only.
  const aliceRow =
    "alice,Alice,A,alice@x.edu,Period 1,42,enrolled,github,oldhash,tok-1,2026-01-01T00:00:00Z,2026-01-02T00:00:00Z\n"
  const bobRow =
    ",Bob,B,bob@x.edu,,,invited,email,bobhash,tok-2,2026-01-01T00:00:00Z,\n"

  it("rewrites only first/last/section and preserves identity + lifecycle columns", async () => {
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
    // identity + lifecycle preserved verbatim
    expect(alice?.username).toBe("alice")
    expect(alice?.github_id).toBe("42")
    expect(alice?.enrollment_status).toBe("enrolled")
    expect(alice?.enrollment_method).toBe("github")
    expect(alice?.invite_token).toBe("tok-1")
    expect(alice?.invited_at).toBe("2026-01-01T00:00:00Z")
    expect(alice?.enrolled_at).toBe("2026-01-02T00:00:00Z")
    // email unchanged -> stored hash untouched (no drift)
    expect(alice?.email_hash).toBe("oldhash")
  })

  it("recomputes email_hash when the email changes", async () => {
    const { client, committed } = makeClient({ startingCsv: HEADER + aliceRow })

    await updateStudent(client, {
      org: "acme",
      classroom: "cs101",
      key: "42",
      patch: {
        first_name: "Alice",
        last_name: "A",
        email: "alice.new@x.edu",
        section: "Period 1",
      },
    })

    const alice = rowsFromCsv(committed.content!).find(
      (r) => r.github_id === "42",
    )
    expect(alice?.email).toBe("alice.new@x.edu")
    expect(alice?.email_hash).toBe(await emailHash("alice.new@x.edu"))
    expect(alice?.email_hash).not.toBe("oldhash")
  })

  it("clears email_hash when the email is cleared", async () => {
    const { client, committed } = makeClient({ startingCsv: HEADER + aliceRow })

    await updateStudent(client, {
      org: "acme",
      classroom: "cs101",
      key: "42",
      patch: { first_name: "Alice", last_name: "A", email: "", section: "" },
    })

    const alice = rowsFromCsv(committed.content!).find(
      (r) => r.username === "alice",
    )
    expect(alice?.email).toBe("")
    expect(alice?.email_hash).toBe("")
  })

  it("matches an email-only row by its email key", async () => {
    const { client, committed } = makeClient({ startingCsv: HEADER + bobRow })

    await updateStudent(client, {
      org: "acme",
      classroom: "cs101",
      key: "bob@x.edu",
      patch: {
        first_name: "Bobby",
        last_name: "Brown",
        email: "bob@x.edu",
        section: "Lab A",
      },
    })

    const bob = rowsFromCsv(committed.content!).find(
      (r) => r.email === "bob@x.edu",
    )
    expect(bob?.first_name).toBe("Bobby")
    expect(bob?.last_name).toBe("Brown")
    expect(bob?.section).toBe("Lab A")
    expect(bob?.enrollment_method).toBe("email")
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

  it("rejects changing the email of an email-only row (re-keys/drops it)", async () => {
    const { client, committed } = makeClient({ startingCsv: HEADER + bobRow })

    // Clearing it (would drop the keyless row from the roster on write).
    await expect(
      updateStudent(client, {
        org: "acme",
        classroom: "cs101",
        key: "bob@x.edu",
        patch: { first_name: "Bob", last_name: "B", email: "   ", section: "" },
      }),
    ).rejects.toThrow(/only identifier|unenroll/i)
    expect(committed.content).toBeNull()

    // Changing it to a different address (would re-key the row).
    await expect(
      updateStudent(client, {
        org: "acme",
        classroom: "cs101",
        key: "bob@x.edu",
        patch: {
          first_name: "Bob",
          last_name: "B",
          email: "bob.new@x.edu",
          section: "",
        },
      }),
    ).rejects.toThrow(/only identifier|unenroll/i)
    expect(committed.content).toBeNull()
  })

  it("rejects changing the email before enrollment is confirmed (invited row with a github_id)", async () => {
    // dave: invited (not enrolled) but already has a github_id + username, so
    // the email-only guard doesn't apply — the pre-enrollment lock must.
    const daveRow =
      "dave,Dave,D,dave@x.edu,,77,invited,github,davehash,tok-4,2026-01-01T00:00:00Z,\n"
    const { client, committed } = makeClient({ startingCsv: HEADER + daveRow })

    await expect(
      updateStudent(client, {
        org: "acme",
        classroom: "cs101",
        key: "77",
        patch: {
          first_name: "Dave",
          last_name: "D",
          email: "dave.new@x.edu",
          section: "",
        },
      }),
    ).rejects.toThrow(/before enrollment is confirmed/i)
    expect(committed.content).toBeNull()
  })

  it("allows editing name/section (email unchanged) on an unenrolled row", async () => {
    const daveRow =
      "dave,Dave,D,dave@x.edu,,77,invited,github,davehash,tok-4,2026-01-01T00:00:00Z,\n"
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
    expect(dave?.enrollment_status).toBe("invited")
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
    const carolRow =
      "carol,Carol,C,carol@x.edu,,,invited,github,carolhash,tok-3,2026-01-01T00:00:00Z,\n"
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

  it("clears email + email_hash via a whitespace-only email on a github-keyed row", async () => {
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
    expect(alice?.email_hash).toBe("")
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
    expect(alice?.enrollment_status).toBe("enrolled")
    expect(alice?.invite_token).toBe("tok-1")
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
    // email is also formula-guarded (member-controlled via sync/bulk import);
    // email_hash is derived from the normalized pre-guard email, so reconcile
    // matching is unaffected.
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
        if (path.includes("/contents/") && path.includes("students.csv")) {
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
        if (path.includes("/contents/") && path.includes("students.csv")) {
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
          const entry = tree?.find((t) => t.path.includes("students.csv"))
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

// Unenroll is classroom-scoped — it never removes an ACTIVE org member
// (that would leave other rosters showing them enrolled while non-member of the
// org). A pending invite is still cancelled. The fake tracks org-membership
// DELETEs and the committed roster so we can assert both.
describe("unenrollStudent — classroom-scoped, no active-member org removal", () => {
  const aliceEnrolled =
    "alice,Alice,A,alice@x.edu,,42,enrolled,github,,tok-1,2026-01-01T00:00:00Z,2026-01-02T00:00:00Z\n"
  const bobInvited =
    "bob,Bob,B,bob@x.edu,,43,invited,email,,tok-2,2026-01-01T00:00:00Z,\n"

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
          if (path.includes("/contents/") && path.includes("students.csv")) {
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
            const entry = tree?.find((t) => t.path.includes("students.csv"))
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
        enrollment_status: "enrolled",
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
        enrollment_status: "invited",
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
        enrollment_status: "enrolled",
      },
    })

    // The only roster write is cs101's students.csv (the committed content),
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
        enrollment_status: "invited",
      },
    })

    // Self: invite NOT cancelled, and a warning explains why.
    expect(orgMembershipDeletes).toHaveLength(0)
    expect(result.teamWarning).toMatch(/signed-in account/i)
  })
})

// Onboarding-bypass reconcile: a student who accepts the org invite directly
// never creates an onboarding repo. The membership pass auto-enrolls rows that
// carry a github_id/username and are active members; the email pass routes
// accepted-but-unidentifiable email rows to needsMatch.
describe("reconcileOnboarding — onboarding-bypass (joined org directly)", () => {
  type ReconcileRosters = Record<string, string>

  const makeReconcileClient = (opts: {
    rosters: ReconcileRosters
    // username (lowercased) -> membership state
    memberships?: Record<string, "active" | "pending" | null>
    // pending invitation emails (lowercased)
    pendingInviteEmails?: string[]
    cleanupMode?: string
    // github_id -> current login, served by GET /user/{id}. Cross-roster email
    // resolution derives the fresh login from the id before binding.
    usersById?: Record<string, string>
  }) => {
    const rosters = { ...opts.rosters }
    const memberships = opts.memberships ?? {}
    const pendingInviteEmails = (opts.pendingInviteEmails ?? []).map((e) =>
      e.toLowerCase(),
    )
    const cleanupMode = opts.cleanupMode ?? "keep"
    const usersById = opts.usersById ?? {}

    const csvResponse = (csv: string) => ({
      type: "file" as const,
      encoding: "base64" as const,
      content: Buffer.from(csv, "utf-8").toString("base64"),
    })

    const classroomOf = (path: string) => {
      const m = path.match(/\/contents\/([^/]+)\/students\.csv/)
      return m ? decodeURIComponent(m[1]) : null
    }
    const usernameFromMembership = (path: string) => {
      const m = path.match(/\/memberships\/([^/?]+)/)
      return m ? decodeURIComponent(m[1]).toLowerCase() : null
    }

    const requestRaw = vi.fn().mockImplementation((path: string) => {
      if (/\/contents\/(\?|$)/.test(path) || path.endsWith("/contents/")) {
        const dirs = Object.keys(rosters).map((name) => ({
          type: "dir",
          name,
          path: name,
        }))
        return Promise.resolve(JSON.stringify(dirs))
      }
      if (path.includes("classroom.json")) {
        return Promise.resolve(
          JSON.stringify({ short_name: "x", onboarding_cleanup: cleanupMode }),
        )
      }
      return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
    })

    const request = vi
      .fn()
      .mockImplementation((path: string, options?: { body?: unknown }) => {
        if (path.includes("/contents/") && path.includes("students.csv")) {
          const cls = classroomOf(path)
          return Promise.resolve(csvResponse((cls && rosters[cls]) ?? HEADER))
        }
        // Onboarding repo listing (none in these tests).
        if (path.includes("/repos?")) {
          return Promise.resolve([])
        }
        // Pending org invitations.
        if (path.includes("/invitations")) {
          return Promise.resolve(
            pendingInviteEmails.map((email, i) => ({
              id: i + 1,
              login: null,
              email,
              role: "direct_member",
              created_at: "2026-01-01T00:00:00Z",
              failed_at: null,
              failed_reason: null,
            })),
          )
        }
        if (path.includes("/memberships/") && !path.includes("/teams/")) {
          const u = usernameFromMembership(path)
          const state = u ? memberships[u] : null
          if (!state) return Promise.reject(new Error("404 not a member"))
          return Promise.resolve({ state })
        }
        // GET /user/{id} -> current login (getUserById), for cross-roster
        // id->login derivation.
        const userByIdMatch = path.match(/\/user\/(\d+)$/)
        if (userByIdMatch) {
          const login = usersById[userByIdMatch[1]]
          if (!login) return Promise.reject(new Error("404 no such user"))
          return Promise.resolve({ login, id: Number(userByIdMatch[1]) })
        }
        if (path.includes("/teams/")) {
          return Promise.resolve({ slug: "classroom50-cs101", id: 7 })
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
          const entry = tree?.find((t) => t.path.includes("students.csv"))
          if (entry?.content) {
            const m = entry.path.match(/^([^/]+)\/students\.csv/)
            if (m) rosters[m[1]] = entry.content
          }
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
      rosters,
    }
  }

  it("auto-enrolls a github_id/username row whose member is active (no repo)", async () => {
    const invited =
      "alice,Alice,A,alice@x.edu,,42,invited,github,,tok-1,2026-01-01T00:00:00Z,\n"
    const { client, rosters } = makeReconcileClient({
      rosters: { cs101: HEADER + invited },
      memberships: { alice: "active" },
    })

    const result = await reconcileOnboarding(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.reconciled).toEqual([
      { email: "alice@x.edu", username: "alice" },
    ])
    const alice = rowsFromCsv(rosters.cs101).find((r) => r.username === "alice")
    expect(alice?.enrollment_status).toBe("enrolled")
    expect(alice?.enrolled_at).toBeTruthy()
  })

  it("leaves a github_id row pending when the member is not active", async () => {
    const invited =
      "bob,Bob,B,bob@x.edu,,43,invited,github,,tok-2,2026-01-01T00:00:00Z,\n"
    const { client, rosters } = makeReconcileClient({
      rosters: { cs101: HEADER + invited },
      memberships: { bob: "pending" },
    })

    const result = await reconcileOnboarding(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.reconciled).toHaveLength(0)
    expect(result.pending).toContain("bob@x.edu")
    const bob = rowsFromCsv(rosters.cs101).find((r) => r.username === "bob")
    expect(bob?.enrollment_status).toBe("invited")
  })

  it("routes an accepted email-only row with no recoverable identity to needsMatch", async () => {
    const carolHash = await emailHash("carol@x.edu")
    const emailOnly = `,,,carol@x.edu,,,invited,email,${carolHash},tok-3,2026-01-01T00:00:00Z,\n`
    const { client } = makeReconcileClient({
      rosters: { cs101: HEADER + emailOnly },
      // No pending invite for carol -> accepted. No other roster to resolve from.
      pendingInviteEmails: [],
    })

    const result = await reconcileOnboarding(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.needsMatch).toEqual([{ email: "carol@x.edu" }])
    expect(result.pending).not.toContain("carol@x.edu")
  })

  it("leaves an email-only row pending while its invite is still pending", async () => {
    const daveHash = await emailHash("dave@x.edu")
    const emailOnly = `,,,dave@x.edu,,,invited,email,${daveHash},tok-4,2026-01-01T00:00:00Z,\n`
    const { client } = makeReconcileClient({
      rosters: { cs101: HEADER + emailOnly },
      pendingInviteEmails: ["dave@x.edu"],
    })

    const result = await reconcileOnboarding(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.needsMatch).toHaveLength(0)
    expect(result.pending).toContain("dave@x.edu")
  })

  it("cross-roster resolves an accepted email-only row to an active member and enrolls", async () => {
    const hash = await emailHash("erin@x.edu")
    const emailOnly = `,,,erin@x.edu,,,invited,email,${hash},tok-5,2026-01-01T00:00:00Z,\n`
    // Stored username in the OTHER roster is stale ("erin-old"); the derived
    // login (via GET /user/55) is authoritative and should win.
    const otherEnrolled = `erin-old,Erin,E,erin@x.edu,,55,enrolled,github,${hash},,2026-01-01T00:00:00Z,2026-01-02T00:00:00Z\n`
    const { client, rosters } = makeReconcileClient({
      rosters: { cs101: HEADER + emailOnly, cs202: HEADER + otherEnrolled },
      pendingInviteEmails: [],
      memberships: { erin: "active" },
      usersById: { "55": "erin" },
    })

    const result = await reconcileOnboarding(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.needsMatch).toHaveLength(0)
    expect(result.reconciled).toEqual([
      { email: "erin@x.edu", username: "erin" },
    ])
    const erin = rowsFromCsv(rosters.cs101).find(
      (r) => r.email === "erin@x.edu",
    )
    // Fresh login derived from the id, NOT the stale stored "erin-old".
    expect(erin?.username).toBe("erin")
    expect(erin?.github_id).toBe("55")
    expect(erin?.enrollment_status).toBe("enrolled")
  })

  it("routes an email that resolves to 2+ distinct github_ids to needsMatch (no guess)", async () => {
    const hash = await emailHash("shared@x.edu")
    const emailOnly = `,,,shared@x.edu,,,invited,email,${hash},tok-6,2026-01-01T00:00:00Z,\n`
    // Same email on two OTHER rosters under DIFFERENT github_ids (a shared /
    // typo'd address). The resolver must not guess which student.
    const otherA = `aa,A,A,shared@x.edu,,61,enrolled,github,${hash},,2026-01-01T00:00:00Z,2026-01-02T00:00:00Z\n`
    const otherB = `bb,B,B,shared@x.edu,,62,enrolled,github,${hash},,2026-01-01T00:00:00Z,2026-01-02T00:00:00Z\n`
    const { client, rosters } = makeReconcileClient({
      rosters: {
        cs101: HEADER + emailOnly,
        cs202: HEADER + otherA,
        cs303: HEADER + otherB,
      },
      pendingInviteEmails: [],
      memberships: { aa: "active", bb: "active" },
      usersById: { "61": "aa", "62": "bb" },
    })

    const result = await reconcileOnboarding(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.needsMatch).toEqual([{ email: "shared@x.edu" }])
    expect(result.reconciled).toHaveLength(0)
    const shared = rowsFromCsv(rosters.cs101).find(
      (r) => r.email === "shared@x.edu",
    )
    expect(shared?.enrollment_status).toBe("invited")
  })
})

describe("matchStudentToAccountWithConflictRetry — teacher manual match (email path)", () => {
  const makeMatchClient = (opts: {
    startingCsv: string
    membershipState?: "active" | "pending" | null
  }) => {
    const committed: { content: string | null } = { content: null }
    const membershipState =
      "membershipState" in opts ? opts.membershipState : "active"

    const requestRaw = vi.fn().mockImplementation((path: string) => {
      if (path.includes("/contents/") && path.includes("classroom.json")) {
        return Promise.resolve(JSON.stringify({ short_name: "cs101" }))
      }
      return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
    })

    const request = vi
      .fn()
      .mockImplementation((path: string, options?: { body?: unknown }) => {
        if (path.includes("/contents/") && path.includes("students.csv")) {
          const csv = committed.content ?? opts.startingCsv
          return Promise.resolve({
            type: "file",
            encoding: "base64",
            content: Buffer.from(csv, "utf-8").toString("base64"),
          })
        }
        if (path.includes("/memberships/") && !path.includes("/teams/")) {
          if (membershipState === null)
            return Promise.reject(new Error("404 not a member"))
          return Promise.resolve({ state: membershipState })
        }
        if (path.includes("/teams/")) {
          return Promise.resolve({ slug: "classroom50-cs101", id: 7 })
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
          const entry = tree?.find((t) => t.path.includes("students.csv"))
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
      })

    return {
      client: { request, requestRaw } as unknown as GitHubClient,
      committed,
    }
  }

  const emailOnlyRow =
    ",,,frank@x.edu,,,invited,email,,tok-6,2026-01-01T00:00:00Z,\n"

  it("writes the picked identity + enrolled for an active member", async () => {
    const { client, committed } = makeMatchClient({
      startingCsv: HEADER + emailOnlyRow,
      membershipState: "active",
    })

    const result = await matchStudentToAccountWithConflictRetry(client, {
      org: "acme",
      classroom: "cs101",
      email: "frank@x.edu",
      username: "frankgh",
      github_id: "66",
    })

    expect(result.alreadyEnrolled).toBe(false)
    const frank = rowsFromCsv(committed.content!).find(
      (r) => r.email === "frank@x.edu",
    )
    expect(frank?.username).toBe("frankgh")
    expect(frank?.github_id).toBe("66")
    expect(frank?.enrollment_status).toBe("enrolled")
    expect(frank?.enrolled_at).toBeTruthy()
  })

  it("refuses to match a non-active account (guard throws, no write)", async () => {
    const { client, committed } = makeMatchClient({
      startingCsv: HEADER + emailOnlyRow,
      membershipState: null,
    })

    await expect(
      matchStudentToAccountWithConflictRetry(client, {
        org: "acme",
        classroom: "cs101",
        email: "frank@x.edu",
        username: "frankgh",
        github_id: "66",
      }),
    ).rejects.toThrow(/not an active member/i)
    expect(committed.content).toBeNull()
  })

  it("throws when no unmatched row exists for the email", async () => {
    const { client } = makeMatchClient({
      startingCsv: HEADER,
      membershipState: "active",
    })

    await expect(
      matchStudentToAccountWithConflictRetry(client, {
        org: "acme",
        classroom: "cs101",
        email: "ghost@x.edu",
        username: "ghostgh",
        github_id: "0",
      }),
    ).rejects.toThrow(/no unmatched roster row/i)
  })
})

describe("reconcileOnboarding — self-report YAML matching", () => {
  const yamlFor = (r: {
    github_id: number
    email: string
    classroom: string
    invite_token?: string
    github_username?: string
  }) =>
    [
      `email: ${r.email}`,
      `first_name: Test`,
      `last_name: Student`,
      `github_username: ${r.github_username ?? "student-gh"}`,
      `github_id: ${r.github_id}`,
      `classroom: ${r.classroom}`,
      ...(r.invite_token ? [`invite_token: ${r.invite_token}`] : []),
    ].join("\n") + "\n"

  // A reconcile client that serves onboarding repos + their YAML + the commit
  // author ids, in addition to the CSV/git endpoints.
  const makeClient = (opts: {
    rosters: Record<string, string>
    // repo name -> { yaml, authorIds }
    repos: Record<string, { yaml: string; authorIds: number[] }>
  }) => {
    const rosters = { ...opts.rosters }
    const repos = opts.repos

    const csvResponse = (csv: string) => ({
      type: "file" as const,
      encoding: "base64" as const,
      content: Buffer.from(csv, "utf-8").toString("base64"),
    })
    const classroomOf = (path: string) => {
      const m = path.match(/\/contents\/([^/]+)\/students\.csv/)
      return m ? decodeURIComponent(m[1]) : null
    }

    const requestRaw = vi.fn().mockImplementation((path: string) => {
      if (path.includes("classroom.json")) {
        return Promise.resolve(
          JSON.stringify({ short_name: "x", onboarding_cleanup: "keep" }),
        )
      }
      return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
    })

    const request = vi
      .fn()
      .mockImplementation((path: string, options?: { body?: unknown }) => {
        // Onboarding repo listing.
        if (/\/orgs\/[^/]+\/repos\?/.test(path)) {
          return Promise.resolve(
            Object.keys(repos).map((name) => ({
              name,
              archived: false,
              default_branch: "main",
            })),
          )
        }
        // Commit author ids for the YAML file.
        const commitsMatch = path.match(/\/repos\/[^/]+\/([^/]+)\/commits\?/)
        if (commitsMatch) {
          const repo = repos[commitsMatch[1]]
          const ids = repo?.authorIds ?? []
          return Promise.resolve([
            {
              author: ids[0] != null ? { id: ids[0] } : null,
              committer: ids[1] != null ? { id: ids[1] } : null,
            },
          ])
        }
        // The onboarding YAML file.
        const yamlMatch = path.match(
          /\/repos\/[^/]+\/([^/]+)\/contents\/\.classroom50-onboarding\.yaml/,
        )
        if (yamlMatch) {
          const repo = repos[yamlMatch[1]]
          if (!repo) return Promise.reject(new Error("404"))
          return Promise.resolve(csvResponse(repo.yaml))
        }
        // Roster read.
        if (path.includes("/contents/") && path.includes("students.csv")) {
          const cls = classroomOf(path)
          return Promise.resolve(csvResponse((cls && rosters[cls]) ?? HEADER))
        }
        if (path.includes("/invitations")) return Promise.resolve([])
        if (path.includes("/memberships/"))
          return Promise.reject(new Error("404"))
        if (path.includes("/teams/"))
          return Promise.resolve({ slug: "classroom50-cs101", id: 7 })
        if (path.includes("/git/ref/"))
          return Promise.resolve({ object: { sha: "base-sha" } })
        if (path.includes("/git/commits/"))
          return Promise.resolve({ tree: { sha: "base-tree-sha" } })
        if (path.endsWith("/git/trees")) {
          const tree = (
            options?.body as { tree?: { path: string; content?: string }[] }
          )?.tree
          const entry = tree?.find((t) => t.path.includes("students.csv"))
          if (entry?.content) {
            const m = entry.path.match(/^([^/]+)\/students\.csv/)
            if (m) rosters[m[1]] = entry.content
          }
          return Promise.resolve({ sha: "tree-sha" })
        }
        if (path.endsWith("/git/commits"))
          return Promise.resolve({ sha: "new-commit-sha" })
        if (path.endsWith("/git/refs/heads/main")) return Promise.resolve({})
        return Promise.reject(new Error(`unexpected request: ${path}`))
      })

    return {
      client: { request, requestRaw } as unknown as GitHubClient,
      rosters,
    }
  }

  const enrolledRow = (csv: string, email: string) =>
    rowsFromCsv(csv).find(
      (r) => r.email === email && r.enrollment_status === "enrolled",
    )

  it("matches a verified self-report to a github_id row and enrolls it", async () => {
    const invited =
      "gitgirl,Git,Girl,git@x.edu,,42,invited,github,,tok-1,2026-01-01T00:00:00Z,\n"
    const { client, rosters } = makeClient({
      rosters: { cs101: HEADER + invited },
      repos: {
        "onboarding-42": {
          yaml: yamlFor({
            github_id: 42,
            email: "git@x.edu",
            classroom: "cs101",
          }),
          authorIds: [42],
        },
      },
    })

    const result = await reconcileOnboarding(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.reconciled).toHaveLength(1)
    expect(enrolledRow(rosters.cs101, "git@x.edu")).toBeTruthy()
  })

  it("rejects a self-report whose commit author is NOT the claimed id (forgery)", async () => {
    const invited =
      "victim,V,V,victim@x.edu,,42,invited,github,,tok-1,2026-01-01T00:00:00Z,\n"
    const { client, rosters } = makeClient({
      rosters: { cs101: HEADER + invited },
      repos: {
        // Claims id 42, but the commit was authored by 999 (a squatter).
        "onboarding-42": {
          yaml: yamlFor({
            github_id: 42,
            email: "victim@x.edu",
            classroom: "cs101",
          }),
          authorIds: [999],
        },
      },
    })

    const result = await reconcileOnboarding(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.reconciled).toHaveLength(0)
    expect(result.unmatched).toHaveLength(1)
    expect(result.unmatched[0].reason).toMatch(/does not match the account/i)
    expect(enrolledRow(rosters.cs101, "victim@x.edu")).toBeUndefined()
  })

  it("binds by invite_token even when the report's github_id/email differ", async () => {
    const token = "c".repeat(32)
    // Email-first row keyed only by email_hash + token; report has a DIFFERENT
    // email and a github_id the row lacks — only the token binds it.
    const hash = await emailHash("roster@x.edu")
    const invited = `,,,roster@x.edu,,,invited,email,${hash},${token},2026-01-01T00:00:00Z,\n`
    const { client, rosters } = makeClient({
      rosters: { cs101: HEADER + invited },
      repos: {
        "onboarding-7": {
          yaml: yamlFor({
            github_id: 7,
            email: "different@x.edu",
            classroom: "cs101",
            invite_token: token,
          }),
          authorIds: [7],
        },
      },
    })

    const result = await reconcileOnboarding(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.reconciled).toHaveLength(1)
    // The email-first row is now enrolled and bound to github_id 7.
    const row = rowsFromCsv(rosters.cs101).find(
      (r) => r.email === "roster@x.edu",
    )
    expect(row?.enrollment_status).toBe("enrolled")
    expect(row?.github_id).toBe("7")
  })

  it("routes an ambiguous email (2 rows) to unmatched, enrolling neither", async () => {
    const hash = await emailHash("dup@x.edu")
    const rowA = `,,,dup@x.edu,,,invited,email,${hash},,2026-01-01T00:00:00Z,\n`
    const rowB = `,,,dup@x.edu,,,invited,email,${hash},,2026-01-02T00:00:00Z,\n`
    const { client, rosters } = makeClient({
      rosters: { cs101: HEADER + rowA + rowB },
      repos: {
        "onboarding-5": {
          yaml: yamlFor({
            github_id: 5,
            email: "dup@x.edu",
            classroom: "cs101",
          }),
          authorIds: [5],
        },
      },
    })

    const result = await reconcileOnboarding(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.reconciled).toHaveLength(0)
    expect(result.unmatched).toHaveLength(1)
    expect(result.unmatched[0].reason).toMatch(/matches 2 roster rows/i)
    expect(
      rowsFromCsv(rosters.cs101).every(
        (r) => r.enrollment_status !== "enrolled",
      ),
    ).toBe(true)
  })

  it("surfaces a verified report that matches no roster row as needsAttention", async () => {
    const { client } = makeClient({
      rosters: { cs101: HEADER },
      repos: {
        "onboarding-88": {
          yaml: yamlFor({
            github_id: 88,
            email: "stranger@x.edu",
            classroom: "cs101",
            github_username: "stranger",
          }),
          authorIds: [88],
        },
      },
    })

    const result = await reconcileOnboarding(client, {
      org: "acme",
      classroom: "cs101",
    })

    expect(result.reconciled).toHaveLength(0)
    expect(result.needsAttention).toEqual([
      { github_id: "88", login: "stranger" },
    ])
  })
})
