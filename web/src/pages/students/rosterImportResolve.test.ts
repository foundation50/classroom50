import { describe, expect, it, vi } from "vitest"
import {
  ID_RESOLUTION_CAP,
  identityKey,
  resolveImportIdentities,
  splitEmailRowsByLink,
} from "./rosterImportResolve"
import type { ParsedImportRow } from "./rosterImportParse"
import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"
import type { GitHubClient } from "@/github-core/client"

const { getUserById } = vi.hoisted(() => ({ getUserById: vi.fn() }))
vi.mock("@/github-core/queries", () => ({ getUserById }))

const client = {} as GitHubClient

// Line numbers are irrelevant to resolution itself, so each fixture row gets a
// distinct one only where a test asserts which line a problem is reported against.
let nextLine = 1
const row = (
  identity: ParsedImportRow["identity"],
  line = nextLine++,
): ParsedImportRow => ({ line, identity })

const noRateLimit: GitHubRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const apiError = (status: number, rateLimit: GitHubRateLimit = noRateLimit) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/user/1",
    message: `status ${status}`,
    body: null,
    rateLimit,
  })

const rateLimitError = () =>
  apiError(403, { ...noRateLimit, remaining: 0, retryAfter: 60 })

describe("resolveImportIdentities", () => {
  it("resolves a github_id from the local org-member map with no network call", async () => {
    getUserById.mockClear()
    const res = await resolveImportIdentities(
      client,
      [row({ githubId: 42 })],
      new Map([[42, "ada"]]),
    )
    expect(res.rows[0]?.identity).toEqual({
      kind: "account",
      username: "ada",
      github_id: "42",
      resolvedFromId: true,
    })
    expect(getUserById).not.toHaveBeenCalled()
  })

  it("falls back to the network only for an id the local map lacks", async () => {
    getUserById.mockClear()
    getUserById.mockResolvedValueOnce({ id: 7, login: "grace" })
    const res = await resolveImportIdentities(
      client,
      [row({ githubId: 42 }), row({ githubId: 7 })],
      new Map([[42, "ada"]]),
    )
    expect(getUserById).toHaveBeenCalledTimes(1)
    expect(res.rows.map((r) => identityKey(r.identity))).toEqual([
      "login:ada",
      "login:grace",
    ])
  })

  it("flags a mismatch when the id resolves to a different login", async () => {
    const res = await resolveImportIdentities(
      client,
      [row({ githubId: 42, username: "ada-old" })],
      new Map([[42, "ada-new"]]),
    )
    expect(res.rows[0]?.identity).toMatchObject({
      username: "ada-new",
      declaredUsername: "ada-old",
    })
  })

  it("does not flag a mismatch when the id and username agree, case aside", async () => {
    const res = await resolveImportIdentities(
      client,
      [row({ githubId: 42, username: "ADA" })],
      new Map([[42, "ada"]]),
    )
    expect(res.rows[0]?.identity).not.toHaveProperty("declaredUsername")
  })

  it("fails closed on a 404 id rather than falling back to the username", async () => {
    getUserById.mockClear()
    getUserById.mockRejectedValueOnce(apiError(404))
    const res = await resolveImportIdentities(
      client,
      [row({ githubId: 999, username: "someone-else" }, 4)],
      new Map(),
    )
    expect(res.rows).toEqual([])
    expect(res.unusable).toEqual([
      {
        line: 4,
        reason: "unresolved-id",
        githubId: "999",
        username: "someone-else",
      },
    ])
  })

  it("fails closed on a malformed id, reporting the line it came from", async () => {
    const res = await resolveImportIdentities(
      client,
      [row({ malformedGithubId: "5.83231E+05", username: "ada" }, 7)],
      new Map(),
    )
    expect(res.rows).toEqual([])
    expect(res.unusable[0]).toMatchObject({
      line: 7,
      reason: "unresolved-id",
      githubId: "5.83231E+05",
    })
  })

  it("stops resolving on a rate limit and reports the rest as a lookup failure", async () => {
    getUserById.mockClear()
    // Lookups run in bounded-concurrency batches, so a rate limit can't unsend the
    // requests already in flight beside it — what it must do is stop the batches
    // AFTER it. 40 ids is several batches; only the first should be spent.
    getUserById.mockRejectedValue(rateLimitError())
    const ids = Array.from({ length: 40 }, (_, i) => i + 1)
    const res = await resolveImportIdentities(
      client,
      ids.map((id) => row({ githubId: id })),
      new Map(),
    )
    expect(getUserById.mock.calls.length).toBeLessThan(ids.length)
    expect(res.rows).toEqual([])
    // A rate limit says nothing about whether the accounts exist, so these must
    // NOT be reported as bad ids — that would send the teacher to edit a fine file.
    expect(res.unusable).toHaveLength(ids.length)
    expect(res.unusable.every((u) => u.reason === "id-lookup-failed")).toBe(
      true,
    )
    getUserById.mockReset()
  })

  it("reports a transient server error as a lookup failure, not a bad id", async () => {
    getUserById.mockClear()
    getUserById.mockRejectedValueOnce(apiError(500))
    const res = await resolveImportIdentities(
      client,
      [row({ githubId: 7, username: "someone-else" })],
      new Map(),
    )
    expect(res.unusable[0]?.reason).toBe("id-lookup-failed")
    // Still fails closed: the username cell is never substituted.
    expect(res.rows).toEqual([])
  })

  it("bounds how many lookups are in flight at once", async () => {
    getUserById.mockClear()
    // A preview blocks on resolution, so the cap must not become that many serial
    // round-trips — but it must not burst either, since GitHub's secondary limits
    // throttle concurrency. Track the high-water mark of overlapping calls.
    let inFlight = 0
    let peak = 0
    getUserById.mockImplementation(async (_c: unknown, id: number) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      inFlight--
      return { id, login: `user${id}` }
    })
    const ids = Array.from({ length: 60 }, (_, i) => i + 1)
    const res = await resolveImportIdentities(
      client,
      ids.map((id) => row({ githubId: id })),
      new Map(),
    )
    expect(res.rows).toHaveLength(ids.length)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(10)
    getUserById.mockReset()
  })

  it("caps the network fallback and reports the rows beyond it", async () => {
    getUserById.mockClear()
    getUserById.mockImplementation((_c: unknown, id: number) =>
      Promise.resolve({ id, login: `user${id}` }),
    )
    const ids = Array.from({ length: ID_RESOLUTION_CAP + 3 }, (_, i) => i + 1)
    const res = await resolveImportIdentities(
      client,
      ids.map((id) => row({ githubId: id })),
      new Map(),
    )
    expect(getUserById).toHaveBeenCalledTimes(ID_RESOLUTION_CAP)
    expect(res.rows).toHaveLength(ID_RESOLUTION_CAP)
    // Capped, not failed: a retry would cap at the same place, so the copy must
    // point at editing the file rather than trying again.
    expect(res.unusable.map((u) => u.reason)).toEqual([
      "id-lookup-capped",
      "id-lookup-capped",
      "id-lookup-capped",
    ])
    getUserById.mockReset()
  })

  it("applies precedence: username over email, email when neither account cell", async () => {
    const res = await resolveImportIdentities(
      client,
      [
        row({ username: "ada", email: "ada@uni.edu" }),
        row({ email: "zoe@uni.edu" }),
      ],
      new Map(),
    )
    expect(res.rows.map((r) => r.identity)).toEqual([
      { kind: "account", username: "ada" },
      { kind: "email", email: "zoe@uni.edu" },
    ])
  })

  it("collapses an id row and a username row naming the same person", async () => {
    const res = await resolveImportIdentities(
      client,
      [row({ githubId: 42 }), row({ username: "ada" })],
      new Map([[42, "ada"]]),
    )
    expect(res.rows).toHaveLength(1)
    // First occurrence wins, so the id-resolved row's metadata is kept.
    expect(res.rows[0]?.identity).toMatchObject({ github_id: "42" })
  })
})

describe("splitEmailRowsByLink", () => {
  const emailRow = (
    email: string,
    metadata: {
      first_name?: string
      last_name?: string
      email?: string
      section?: string
    } = {},
  ) => ({ identity: { kind: "email" as const, email }, ...metadata })
  const studentFor = () => "student" as const

  it("partitions linked rows out of the invite list, preserving file order", () => {
    const rows = [
      emailRow("ada@uni.edu"),
      emailRow("bob@uni.edu"),
      emailRow("cara@uni.edu"),
    ]
    const links = [
      { email: "cara@uni.edu", id: 3, login: "cara", classroom: "cs50-2025" },
      { email: "ada@uni.edu", id: 1, login: "ada", classroom: "cs50-2024" },
    ]
    const res = splitEmailRowsByLink(rows, links, studentFor)
    expect(res.linkedRows.map((r) => r.username)).toEqual(["ada", "cara"])
    // The confirmed binding echoes the LINK's account and source classroom.
    expect(res.linkedEmails).toEqual([
      { email: "ada@uni.edu", login: "ada", classroom: "cs50-2024" },
      { email: "cara@uni.edu", login: "cara", classroom: "cs50-2025" },
    ])
    expect(res.emailInvites.map((i) => i.email)).toEqual(["bob@uni.edu"])
  })

  it("carries metadata onto the linked account row and the invite alike", () => {
    const metadata = { first_name: "Ada", last_name: "Lovelace", section: "L1" }
    const res = splitEmailRowsByLink(
      [emailRow("ada@uni.edu", metadata), emailRow("zoe@uni.edu", metadata)],
      [{ email: "ada@uni.edu", id: 42, login: "ada", classroom: "cs50" }],
      studentFor,
    )
    // The link's id rides along so downstream writes join on the account.
    expect(res.linkedRows).toEqual([
      {
        username: "ada",
        github_id: "42",
        email: "ada@uni.edu",
        role: "student",
        ...metadata,
      },
    ])
    expect(res.emailInvites).toEqual([
      { email: "zoe@uni.edu", role: "student", ...metadata },
    ])
  })

  it("assigns each row the role the teacher chose for its identity", () => {
    const res = splitEmailRowsByLink(
      [emailRow("ada@uni.edu"), emailRow("prof@uni.edu")],
      [{ email: "ada@uni.edu", id: 1, login: "ada", classroom: "cs50" }],
      (identity) =>
        identity.kind === "email" && identity.email === "prof@uni.edu"
          ? "teacher"
          : "ta",
    )
    expect(res.linkedRows[0]?.role).toBe("ta")
    expect(res.emailInvites[0]?.role).toBe("teacher")
  })

  it("keeps the raw metadata email cell, falling back to the identity address", () => {
    // Stored roster addresses keep their casing (metadata compares
    // case-sensitively); only a row with no email cell takes the normalized one.
    const res = splitEmailRowsByLink(
      [
        emailRow("ada@uni.edu", { email: "Ada@Uni.edu" }),
        emailRow("bob@uni.edu"),
      ],
      [
        { email: "ada@uni.edu", id: 1, login: "ada", classroom: "cs50" },
        { email: "bob@uni.edu", id: 2, login: "bob", classroom: "cs50" },
      ],
      studentFor,
    )
    expect(res.linkedRows.map((r) => r.email)).toEqual([
      "Ada@Uni.edu",
      "bob@uni.edu",
    ])
  })

  it("returns three empty buckets for no email rows", () => {
    expect(
      splitEmailRowsByLink(
        [],
        [{ email: "a@x.io", id: 1, login: "a", classroom: "c" }],
        studentFor,
      ),
    ).toEqual({ linkedRows: [], linkedEmails: [], emailInvites: [] })
  })
})
