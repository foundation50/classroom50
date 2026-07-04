import { describe, expect, it, vi } from "vitest"
import Papa from "papaparse"

import {
  enrollStudentInClassroom,
  inviteStudentByEmail,
  matchStudentToAccountWithConflictRetry,
  unenrollStudent,
  updateStudent,
  updateStudentWithConflictRetry,
  STUDENT_CSV_FIELDS,
} from "./students"
import { GitHubAPIError } from "@/hooks/github/errors"
import type { GitHubClient } from "@/hooks/github/client"

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

const HEADER = "username,first_name,last_name,email,section,github_id\n"

// The web leg of the three-way students.csv header lockstep. The Go
// (TestFullRosterHeader) and Python (test_full_roster_header_matches_go_constant)
// suites each pin their own header constant to this exact string; the web app is
// what WRITES the file's column order (via STUDENT_CSV_FIELDS), so without this
// assertion a web-only reorder/rename would keep every web test green while the
// CLI's ParseRoster and the collector's read_students_csv reject every roster
// the web subsequently writes. Pin the source-of-truth constant, not a fixture.
describe("students.csv header lockstep (web leg)", () => {
  it("STUDENT_CSV_FIELDS matches the Go/Python header verbatim", () => {
    expect(STUDENT_CSV_FIELDS.join(",")).toBe(
      "username,first_name,last_name,email,section,github_id",
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
    // Omit the persisted classroom-team block so the invite can't attach a team,
    // exercising the team-less-invite warning path.
    noTeamBlock?: boolean
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
        // Include a persisted team block by default so the happy path attaches
        // it; opts.noTeamBlock omits it to exercise the team-less-invite warning.
        const meta: Record<string, unknown> = { short_name: "x" }
        if (!opts.noTeamBlock) {
          meta.team = { slug: "classroom50-x", id: 4242 }
        }
        return Promise.resolve(JSON.stringify(meta))
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
    return `${username},${firstName},${lastName},${email},sec-other,${id}\n`
  }

  it("invite succeeds for a new email -> row is written", async () => {
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
    expect(rows.find((r) => r.email === "new@x.edu")).toBeTruthy()
  })

  it("warns when the classroom team can't be attached (team-less invite risk)", async () => {
    // With no persisted team block, the invite goes out team-less. That must
    // warn: with the onboarding reconcile path removed and collection now
    // team-driven, a student who accepts a team-less invite is uncollected
    // until the teacher runs Sync roster. The invite MUST still be sent.
    const { client, rosters } = makeEmailClient({
      rosters: { cs101: HEADER },
      inviteSucceeds: true,
      noTeamBlock: true,
    })

    const result = await inviteStudentByEmail(client, {
      org: "acme",
      classroom: "cs101",
      email: "noteam@x.edu",
    })

    expect(result.inviteWarning).toMatch(/team couldn't be attached/i)
    expect(result.inviteWarning).toMatch(/sync roster/i)
    // The row still committed and the student was still invited.
    expect(
      rowsFromCsv(rosters.cs101).find((r) => r.email === "noteam@x.edu"),
    ).toBeTruthy()
  })

  it("does not warn when the team attaches cleanly", async () => {
    const { client } = makeEmailClient({
      rosters: { cs101: HEADER },
      inviteSucceeds: true,
    })
    const result = await inviteStudentByEmail(client, {
      org: "acme",
      classroom: "cs101",
      email: "hasteam@x.edu",
    })
    expect(result.inviteWarning).toBeUndefined()
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
    // Fresh login derived from id 77, not the stale stored "carol-old".
    expect(row?.username).toBe("carol")
    expect(row?.github_id).toBe("77")
    expect(row?.first_name).toBe("Carol")
    expect(row?.last_name).toBe("Diaz")
    expect(row?.section ?? "").not.toBe("sec-other")
    expect(result.student.username).toBe("carol")
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
    expect(ghost?.username).toBe("")
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
      },
    })

    // Self: invite NOT cancelled, and a warning explains why.
    expect(orgMembershipDeletes).toHaveLength(0)
    expect(result.teamWarning).toMatch(/signed-in account/i)
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

  const emailOnlyRow = ",,,frank@x.edu,,\n"

  it("writes the picked identity onto the email-only row for an active member", async () => {
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
