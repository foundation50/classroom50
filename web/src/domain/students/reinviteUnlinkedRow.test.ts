// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const getOrgFailedInvitations = vi.fn()
const cancelOrgInvitation = vi.fn()
const bulkInviteByEmail = vi.fn()

vi.mock("@/github-core/queries", () => ({
  getOrgFailedInvitations: (...a: unknown[]) => getOrgFailedInvitations(...a),
}))
vi.mock("@/github-core/mutations", () => ({
  cancelOrgInvitation: (...a: unknown[]) => cancelOrgInvitation(...a),
}))
vi.mock("./inviteRoster", () => ({
  bulkInviteByEmail: (...a: unknown[]) => bulkInviteByEmail(...a),
}))
vi.mock("./rosterPrimitives", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

import { reinviteUnlinkedRow } from "./reinviteUnlinkedRow"
import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"

const client = {} as never
const INPUT = {
  org: "acme",
  classroom: "cs101",
  email: "Grace@Uni.edu",
  role: "student" as const,
}

const emptyRateLimit: GitHubRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const sentResult = {
  invited: [{ email: "Grace@Uni.edu", role: "student" }],
  skipped: [],
  failed: [],
  deferred: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  getOrgFailedInvitations.mockResolvedValue([])
  cancelOrgInvitation.mockResolvedValue({ cancelled: true })
  bulkInviteByEmail.mockResolvedValue(sentResult)
})

describe("reinviteUnlinkedRow", () => {
  it("dismisses the address's failed invitations, then re-invites by email", async () => {
    getOrgFailedInvitations.mockResolvedValue([
      { id: 1, email: "grace@uni.edu", login: null },
      { id: 2, email: "someone-else@uni.edu", login: null },
      { id: 3, email: null, login: "octocat" },
    ])

    const result = await reinviteUnlinkedRow(client, INPUT)

    expect(result).toEqual({ status: "sent" })
    // Only the matching address is dismissed (case-insensitive), nobody else's.
    expect(cancelOrgInvitation).toHaveBeenCalledTimes(1)
    expect(cancelOrgInvitation).toHaveBeenCalledWith(client, {
      org: "acme",
      invitationId: 1,
    })
    expect(bulkInviteByEmail).toHaveBeenCalledWith(client, {
      org: "acme",
      classroom: "cs101",
      invites: [{ email: "Grace@Uni.edu", role: "student" }],
    })
  })

  it("still invites when the failed list is unreadable", async () => {
    getOrgFailedInvitations.mockRejectedValue(
      new GitHubAPIError({
        status: 403,
        url: "https://api.github.com/orgs/acme/failed_invitations",
        message: "forbidden",
        body: null,
        rateLimit: emptyRateLimit,
      }),
    )

    await expect(reinviteUnlinkedRow(client, INPUT)).resolves.toEqual({
      status: "sent",
    })
    expect(cancelOrgInvitation).not.toHaveBeenCalled()
    expect(bulkInviteByEmail).toHaveBeenCalledTimes(1)
  })

  it("still invites when dismissing a failed invitation throws", async () => {
    getOrgFailedInvitations.mockResolvedValue([
      { id: 1, email: "grace@uni.edu", login: null },
    ])
    cancelOrgInvitation.mockRejectedValue(new Error("boom"))

    await expect(reinviteUnlinkedRow(client, INPUT)).resolves.toEqual({
      status: "sent",
    })
    expect(bulkInviteByEmail).toHaveBeenCalledTimes(1)
  })

  it("reports a 422 skip as already-invited-or-member, not as sent", async () => {
    bulkInviteByEmail.mockResolvedValue({
      ...sentResult,
      invited: [],
      skipped: [{ email: "Grace@Uni.edu" }],
    })

    await expect(reinviteUnlinkedRow(client, INPUT)).resolves.toEqual({
      status: "already-invited-or-member",
    })
  })

  it("reports a deferred (rate-limited) send as rate-limited", async () => {
    bulkInviteByEmail.mockResolvedValue({
      ...sentResult,
      invited: [],
      deferred: ["Grace@Uni.edu"],
    })

    await expect(reinviteUnlinkedRow(client, INPUT)).resolves.toEqual({
      status: "rate-limited",
    })
  })

  it("throws the invite failure message so the caller shows it", async () => {
    bulkInviteByEmail.mockResolvedValue({
      ...sentResult,
      invited: [],
      failed: [{ email: "Grace@Uni.edu", message: "team missing" }],
    })

    await expect(reinviteUnlinkedRow(client, INPUT)).rejects.toThrow(
      "team missing",
    )
  })

  it("refuses a blank address before touching GitHub", async () => {
    await expect(
      reinviteUnlinkedRow(client, { ...INPUT, email: "   " }),
    ).rejects.toThrow(/email/)
    expect(getOrgFailedInvitations).not.toHaveBeenCalled()
    expect(bulkInviteByEmail).not.toHaveBeenCalled()
  })
})
