// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest"

const buildIdentityDirectory = vi.fn()
const getUserById = vi.fn()
const readOrgMembershipState = vi.fn()

vi.mock("./identityDirectory", () => ({
  buildIdentityDirectory: (...a: unknown[]) => buildIdentityDirectory(...a),
}))
vi.mock("@/github-core/queries", () => ({
  getUserById: (...a: unknown[]) => getUserById(...a),
}))
vi.mock("@/github-core/mutations", () => ({
  readOrgMembershipState: (...a: unknown[]) => readOrgMembershipState(...a),
}))

import { resolveEmailRows } from "./resolveEmailRows"

const client = {} as never
const ORG = "org"

const directory = (
  byEmail: [
    string,
    { id: number; login: string; classroom: string } | "ambiguous",
  ][],
  degraded = false,
) => ({
  byEmail: new Map(byEmail),
  members: [],
  degraded,
})

beforeEach(() => {
  vi.clearAllMocks()
  buildIdentityDirectory.mockResolvedValue(directory([]))
  readOrgMembershipState.mockResolvedValue("active")
})

describe("resolveEmailRows", () => {
  it("links a unique match under the CURRENT login, not the directory's stale one", async () => {
    buildIdentityDirectory.mockResolvedValue(
      directory([["a@x.com", { id: 1, login: "ada-old", classroom: "cs101" }]]),
    )
    // The student renamed since the roster recorded the mapping.
    getUserById.mockResolvedValue({ id: 1, login: "ada-new" })

    const { links, degraded } = await resolveEmailRows(client, ORG, ["a@x.com"])
    expect(links).toEqual([
      { email: "a@x.com", id: 1, login: "ada-new", classroom: "cs101" },
    ])
    expect(degraded).toBe(false)
    expect(getUserById).toHaveBeenCalledWith(client, 1)
    // Membership is checked against the CURRENT login.
    expect(readOrgMembershipState).toHaveBeenCalledWith(client, ORG, "ada-new")
  })

  it("skips an ambiguous address without any verification reads", async () => {
    buildIdentityDirectory.mockResolvedValue(
      directory([["shared@x.com", "ambiguous"]]),
    )

    const { links } = await resolveEmailRows(client, ORG, ["shared@x.com"])
    expect(links).toEqual([])
    expect(getUserById).not.toHaveBeenCalled()
    expect(readOrgMembershipState).not.toHaveBeenCalled()
  })

  it("skips an address whose id lookup fails, without throwing", async () => {
    buildIdentityDirectory.mockResolvedValue(
      directory([["a@x.com", { id: 1, login: "ada", classroom: "cs101" }]]),
    )
    getUserById.mockRejectedValue(new Error("404"))

    const { links } = await resolveEmailRows(client, ORG, ["a@x.com"])
    expect(links).toEqual([])
    expect(readOrgMembershipState).not.toHaveBeenCalled()
  })

  it("skips a non-active membership, and a membership read failure", async () => {
    buildIdentityDirectory.mockResolvedValue(
      directory([
        ["p@x.com", { id: 1, login: "pending-p", classroom: "cs101" }],
        ["n@x.com", { id: 2, login: "gone-n", classroom: "cs101" }],
        ["e@x.com", { id: 3, login: "err-e", classroom: "cs101" }],
      ]),
    )
    getUserById.mockImplementation(async (_c: unknown, id: number) => ({
      id,
      login: `login-${id}`,
    }))
    readOrgMembershipState
      .mockResolvedValueOnce("pending")
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("boom"))

    const { links } = await resolveEmailRows(client, ORG, [
      "p@x.com",
      "n@x.com",
      "e@x.com",
    ])
    expect(links).toEqual([])
  })

  it("performs no reads at all for an empty input", async () => {
    const out = await resolveEmailRows(client, ORG, [])
    expect(out).toEqual({ links: [], degraded: false })
    expect(buildIdentityDirectory).not.toHaveBeenCalled()
    expect(getUserById).not.toHaveBeenCalled()
    expect(readOrgMembershipState).not.toHaveBeenCalled()
  })

  it("normalizes and dedupes addresses before consulting the directory", async () => {
    buildIdentityDirectory.mockResolvedValue(
      directory([["a@x.com", { id: 1, login: "ada", classroom: "cs101" }]]),
    )
    getUserById.mockResolvedValue({ id: 1, login: "ada" })

    const { links } = await resolveEmailRows(client, ORG, [
      " A@X.com ",
      "a@x.com",
    ])
    expect(links).toEqual([
      { email: "a@x.com", id: 1, login: "ada", classroom: "cs101" },
    ])
    expect(getUserById).toHaveBeenCalledTimes(1)
  })

  it("propagates a degraded directory", async () => {
    buildIdentityDirectory.mockResolvedValue(directory([], true))

    const { links, degraded } = await resolveEmailRows(client, ORG, ["a@x.com"])
    expect(links).toEqual([])
    expect(degraded).toBe(true)
  })
})
