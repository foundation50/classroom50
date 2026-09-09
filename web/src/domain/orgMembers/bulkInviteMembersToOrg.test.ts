import { beforeEach, describe, expect, it, vi } from "vitest"

import { bulkInviteMembersToOrg } from "./bulkInviteMembersToOrg"
import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"
import type { OrgMemberRow } from "@/util/orgMembers"

const inviteMemberToOrg = vi.fn()
vi.mock("./inviteMemberToOrg", () => ({
  inviteMemberToOrg: (...args: unknown[]) => inviteMemberToOrg(...args),
}))
vi.mock("@/github-core/errorMessage", () => ({
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}))

const client = {} as never

const row = (over: Partial<OrgMemberRow>): OrgMemberRow => ({
  key: over.username || over.email || "k",
  username: "",
  github_id: "",
  name: "",
  email: "",
  emails: [],
  isMember: false,
  classrooms: [],
  classification: "on-roster-not-member",
  unprovisionedClassrooms: [],
  ...over,
})

const emptyRateLimit: GitHubRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}
const rateLimitError = () =>
  new Error("rate limited", {
    cause: new GitHubAPIError({
      status: 429,
      url: "https://api.github.com/x",
      message: "rate limited",
      body: null,
      rateLimit: emptyRateLimit,
    }),
  })

beforeEach(() => {
  vi.clearAllMocks()
})

describe("bulkInviteMembersToOrg", () => {
  it("invites each eligible row and buckets pending/active as skipped", async () => {
    inviteMemberToOrg
      .mockResolvedValueOnce({ state: "invited" })
      .mockResolvedValueOnce({ state: "pending" })
      .mockResolvedValueOnce({ state: "active" })
    const progress: number[] = []

    const res = await bulkInviteMembersToOrg(client, {
      org: "acme",
      rows: [
        row({ username: "a", github_id: "1" }),
        row({ username: "b", github_id: "2" }),
        row({ username: "c", github_id: "3" }),
      ],
      onProgress: (p) => progress.push(p.processed),
    })

    expect(res.invitedCount).toBe(1)
    expect(res.rateLimited).toBe(false)
    expect(res.outcomes.map((o) => [o.key, o.status, o.detail])).toEqual([
      ["a", "invited", undefined],
      ["b", "skipped", "already-pending"],
      ["c", "skipped", "already-member"],
    ])
    expect(progress).toEqual([1, 2, 3])
  })

  it("skips ineligible rows up front without calling the invite", async () => {
    const res = await bulkInviteMembersToOrg(client, {
      org: "acme",
      rows: [
        row({ email: "ghost@x.edu", classification: "unlinked" }),
        row({
          username: "pend",
          github_id: "9",
          classification: "invitation-pending",
        }),
        row({ username: "noid", github_id: "" }),
      ],
    })

    expect(inviteMemberToOrg).not.toHaveBeenCalled()
    expect(res.outcomes.map((o) => o.detail)).toEqual([
      "not-invitable",
      "already-pending",
      "not-invitable",
    ])
  })

  it("stops at a rate limit and defers the rest", async () => {
    inviteMemberToOrg
      .mockResolvedValueOnce({ state: "invited" })
      .mockRejectedValueOnce(rateLimitError())

    const res = await bulkInviteMembersToOrg(client, {
      org: "acme",
      rows: [
        row({ username: "a", github_id: "1" }),
        row({ username: "b", github_id: "2" }),
        row({ username: "c", github_id: "3" }),
      ],
    })

    expect(inviteMemberToOrg).toHaveBeenCalledTimes(2)
    expect(res.rateLimited).toBe(true)
    expect(res.outcomes.map((o) => o.status)).toEqual([
      "invited",
      "deferred",
      "deferred",
    ])
  })

  it("records a non-rate-limit failure and keeps going", async () => {
    inviteMemberToOrg
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ state: "invited" })

    const res = await bulkInviteMembersToOrg(client, {
      org: "acme",
      rows: [
        row({ username: "a", github_id: "1" }),
        row({ username: "b", github_id: "2" }),
      ],
    })

    expect(res.outcomes[0]).toMatchObject({ status: "failed", detail: "boom" })
    expect(res.outcomes[1]).toMatchObject({ status: "invited" })
    expect(res.invitedCount).toBe(1)
  })
})
