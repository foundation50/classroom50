import { describe, expect, it, vi } from "vitest"
import {
  ID_RESOLUTION_CAP,
  identityKey,
  resolveImportIdentities,
} from "./rosterImportResolve"
import type { ParsedImportRow } from "./rosterImportParse"
import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"
import type { GitHubClient } from "@/github-core/client"

const { getUserById } = vi.hoisted(() => ({ getUserById: vi.fn() }))
vi.mock("@/github-core/queries", () => ({ getUserById }))

const client = {} as GitHubClient

const row = (identity: ParsedImportRow["identity"]): ParsedImportRow => ({
  identity,
})

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
      [row({ githubId: 999, username: "someone-else" })],
      new Map(),
    )
    expect(res.rows).toEqual([])
    expect(res.unusable).toEqual([
      { reason: "unresolved-id", githubId: "999", username: "someone-else" },
    ])
  })

  it("fails closed on a malformed id", async () => {
    const res = await resolveImportIdentities(
      client,
      [row({ malformedGithubId: "5.83231E+05", username: "ada" })],
      new Map(),
    )
    expect(res.rows).toEqual([])
    expect(res.unusable[0]?.reason).toBe("unresolved-id")
  })

  it("stops resolving on a rate limit and reports the rest", async () => {
    getUserById.mockClear()
    getUserById.mockRejectedValueOnce(rateLimitError())
    const res = await resolveImportIdentities(
      client,
      [row({ githubId: 1 }), row({ githubId: 2 })],
      new Map(),
    )
    expect(getUserById).toHaveBeenCalledTimes(1)
    expect(res.rows).toEqual([])
    expect(res.unusable).toHaveLength(2)
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
    expect(res.unusable).toHaveLength(3)
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

  it("reports a row with no identity cell at all", async () => {
    const res = await resolveImportIdentities(client, [row({})], new Map())
    expect(res.rows).toEqual([])
    expect(res.unusable).toEqual([{ reason: "no-identity" }])
  })
})
