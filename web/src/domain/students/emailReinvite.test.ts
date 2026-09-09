// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const getOrgFailedInvitations = vi.fn()
const bulkInviteByEmail = vi.fn()

vi.mock("@/github-core/queries", () => ({
  getOrgFailedInvitations: (...a: unknown[]) => getOrgFailedInvitations(...a),
}))
vi.mock("./inviteRoster", () => ({
  bulkInviteByEmail: (...a: unknown[]) => bulkInviteByEmail(...a),
}))
vi.mock("./rosterPrimitives", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  dismissFailedInvitation: vi.fn(),
}))

import { reinviteEmailRows, reinviteEmailRow } from "./emailReinvite"
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
const apiError = (status: number, rateLimit = emptyRateLimit) =>
  new GitHubAPIError({
    status,
    url: "/orgs/acme/failed_invitations",
    message: "nope",
    body: null,
    rateLimit,
  })

const sentResult = {
  invited: [{ email: "Grace@Uni.edu", role: "student" }],
  skipped: [],
  failed: [],
  deferred: [],
}

const invitesSent = () =>
  (bulkInviteByEmail.mock.calls[0]![1] as { invites: unknown[] }).invites

beforeEach(() => {
  vi.clearAllMocks()
  getOrgFailedInvitations.mockResolvedValue([])
  bulkInviteByEmail.mockResolvedValue(sentResult)
})

describe("reinviteEmailRow", () => {
  it("hands the address's failed records to the send, which dismisses them only once the invite is out", async () => {
    getOrgFailedInvitations.mockResolvedValue([
      { id: 1, email: "grace@uni.edu", login: null },
      { id: 2, email: "someone-else@uni.edu", login: null },
      { id: 3, email: null, login: "octocat" },
    ])

    const result = await reinviteEmailRow(client, INPUT)

    expect(result).toEqual({ status: "sent" })
    // Only the matching address's records (case-insensitive), nobody else's;
    // nothing is dismissed here, bulkInviteByEmail owns the ordering.
    expect(invitesSent()).toEqual([
      {
        email: "Grace@Uni.edu",
        role: "student",
        pendingInvitationId: undefined,
        failedInvitationIds: [1],
      },
    ])
  })

  it("adds the record the roster attributed without duplicating it", async () => {
    getOrgFailedInvitations.mockResolvedValue([
      { id: 7, email: "grace@uni.edu", login: null },
    ])

    await reinviteEmailRow(client, { ...INPUT, failedInvitationId: 7 })

    expect(invitesSent()[0]).toMatchObject({ failedInvitationIds: [7] })
  })

  it("keeps the attributed record when the failed list is unreadable (403)", async () => {
    getOrgFailedInvitations.mockRejectedValue(apiError(403))

    const result = await reinviteEmailRow(client, {
      ...INPUT,
      failedInvitationId: 9,
    })

    expect(result).toEqual({ status: "sent" })
    expect(invitesSent()[0]).toMatchObject({ failedInvitationIds: [9] })
  })

  it("passes no ids when the failed list is unreadable and nothing was attributed", async () => {
    getOrgFailedInvitations.mockRejectedValue(apiError(404))

    await reinviteEmailRow(client, INPUT)

    expect(invitesSent()[0]).toMatchObject({ failedInvitationIds: undefined })
  })

  it("lets a rate-limited failed-list read propagate instead of sending blind", async () => {
    getOrgFailedInvitations.mockRejectedValue(
      apiError(403, { ...emptyRateLimit, remaining: 0, retryAfter: 30 }),
    )

    await expect(reinviteEmailRow(client, INPUT)).rejects.toBeInstanceOf(
      GitHubAPIError,
    )
    expect(bulkInviteByEmail).not.toHaveBeenCalled()
  })

  it("threads the pending invitation id so the send can cancel it right before the create", async () => {
    await reinviteEmailRow(client, { ...INPUT, pendingInvitationId: 42 })

    expect(invitesSent()[0]).toMatchObject({ pendingInvitationId: 42 })
  })

  it("reports a 422 skip as already-invited-or-member, not as sent", async () => {
    bulkInviteByEmail.mockResolvedValue({
      invited: [],
      skipped: [{ email: "Grace@Uni.edu" }],
      failed: [],
      deferred: [],
    })

    await expect(reinviteEmailRow(client, INPUT)).resolves.toEqual({
      status: "already-invited-or-member",
    })
  })

  it("reports a deferred (rate-limited) send as rate-limited", async () => {
    bulkInviteByEmail.mockResolvedValue({
      invited: [],
      skipped: [],
      failed: [],
      deferred: ["Grace@Uni.edu"],
    })

    await expect(reinviteEmailRow(client, INPUT)).resolves.toEqual({
      status: "rate-limited",
    })
  })

  it("throws the invite failure message so the caller shows it", async () => {
    bulkInviteByEmail.mockResolvedValue({
      invited: [],
      skipped: [],
      failed: [{ email: "Grace@Uni.edu", message: "team missing" }],
      deferred: [],
    })

    await expect(reinviteEmailRow(client, INPUT)).rejects.toThrow(
      "team missing",
    )
  })

  it("refuses a blank address before touching GitHub", async () => {
    await expect(
      reinviteEmailRow(client, { ...INPUT, email: "   " }),
    ).rejects.toThrow(/requires an email/)
    expect(getOrgFailedInvitations).not.toHaveBeenCalled()
    expect(bulkInviteByEmail).not.toHaveBeenCalled()
  })
})

describe("reinviteEmailRows (batch)", () => {
  it("reads the failed list once and attributes every matching record per address", async () => {
    getOrgFailedInvitations.mockResolvedValue([
      { id: 1, email: "a@uni.edu", login: null },
      { id: 2, email: "A@uni.edu", login: null },
      { id: 3, email: "b@uni.edu", login: null },
      { id: 4, email: "nobody@uni.edu", login: null },
    ])

    await reinviteEmailRows(client, {
      org: "acme",
      classroom: "cs101",
      targets: [
        { email: "a@uni.edu", role: "student", pendingInvitationId: 10 },
        { email: "b@uni.edu", role: "ta", failedInvitationId: 3 },
      ],
    })

    expect(getOrgFailedInvitations).toHaveBeenCalledTimes(1)
    expect(invitesSent()).toEqual([
      {
        email: "a@uni.edu",
        role: "student",
        pendingInvitationId: 10,
        failedInvitationIds: [1, 2],
      },
      {
        email: "b@uni.edu",
        role: "ta",
        pendingInvitationId: undefined,
        failedInvitationIds: [3],
      },
    ])
  })

  it("drops blank addresses and sends nothing for an empty batch", async () => {
    const res = await reinviteEmailRows(client, {
      org: "acme",
      classroom: "cs101",
      targets: [{ email: " ", role: "student" }],
    })

    expect(res).toEqual({ invited: [], skipped: [], failed: [], deferred: [] })
    expect(getOrgFailedInvitations).not.toHaveBeenCalled()
    expect(bulkInviteByEmail).not.toHaveBeenCalled()
  })
})
