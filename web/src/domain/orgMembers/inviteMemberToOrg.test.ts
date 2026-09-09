import { beforeEach, describe, expect, it, vi } from "vitest"

import { inviteMemberToOrg } from "./inviteMemberToOrg"
import type { OrgMemberRow } from "@/util/orgMembers"

const createOrgInvitationMock = vi.fn()
const ensureOrgMembershipMock = vi.fn()
const getUserByIdMock = vi.fn()
const dismissFailedInvitationMock = vi.fn()
const resolveTeamIdForRoleReadMock = vi.fn()

vi.mock("@/github-core/mutations", () => ({
  createOrgInvitation: (...args: unknown[]) => createOrgInvitationMock(...args),
  ensureOrgMembership: (...args: unknown[]) => ensureOrgMembershipMock(...args),
}))
vi.mock("@/github-core/errorMessage", () => ({
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}))
vi.mock("@/github-core/queries", () => ({
  getUserById: (...args: unknown[]) => getUserByIdMock(...args),
}))
vi.mock("@/domain/students", () => ({
  dismissFailedInvitation: (...args: unknown[]) =>
    dismissFailedInvitationMock(...args),
  resolveTeamIdForRoleRead: (...args: unknown[]) =>
    resolveTeamIdForRoleReadMock(...args),
}))

const client = {} as never

const row = (over: Partial<OrgMemberRow>): OrgMemberRow => ({
  key: "42",
  username: "old-handle",
  github_id: "42",
  name: "Alice",
  email: "alice@x.edu",
  emails: [],
  isMember: false,
  classrooms: [],
  classification: "on-roster-not-member",
  unprovisionedClassrooms: [],
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  createOrgInvitationMock.mockResolvedValue({})
  ensureOrgMembershipMock.mockResolvedValue({ state: "invited" })
  getUserByIdMock.mockResolvedValue({ login: "new-handle" })
  dismissFailedInvitationMock.mockResolvedValue(undefined)
  resolveTeamIdForRoleReadMock.mockResolvedValue(undefined)
})

describe("inviteMemberToOrg", () => {
  it("invites by numeric github_id through ensureOrgMembership, not by the stale username", async () => {
    const result = await inviteMemberToOrg(client, {
      org: "acme",
      row: row({ github_id: "42", username: "old-handle" }),
    })

    expect(ensureOrgMembershipMock).toHaveBeenCalledWith(client, {
      org: "acme",
      // Prechecks with the CURRENT login resolved from the immutable id.
      username: "new-handle",
      inviteeId: 42,
      teamIds: undefined,
    })
    expect(createOrgInvitationMock).not.toHaveBeenCalled()
    expect(result).toEqual({ currentUsername: "new-handle", state: "invited" })
  })

  it("attaches every active classroom's student team, skipping archived ones and ones classroom.json names no team for", async () => {
    resolveTeamIdForRoleReadMock.mockImplementation(
      (_c: unknown, _o: unknown, classroom: string) =>
        Promise.resolve(classroom === "cs101" ? 1001 : undefined),
    )

    await inviteMemberToOrg(client, {
      org: "acme",
      row: row({
        classrooms: [
          {
            classroom: "cs101",
            archived: false,
            section: "",
            state: "enrolled",
          },
          {
            classroom: "cs201",
            archived: false,
            section: "",
            state: "enrolled",
          },
          { classroom: "old", archived: true, section: "", state: "enrolled" },
        ],
      }),
    })

    const classroomsAsked = resolveTeamIdForRoleReadMock.mock.calls.map(
      (c) => c[2],
    )
    expect(classroomsAsked).toEqual(["cs101", "cs201"])
    expect(ensureOrgMembershipMock.mock.calls[0]?.[1]).toMatchObject({
      teamIds: [1001],
    })
  })

  it("propagates a failed team read instead of sending a team-less invite", async () => {
    resolveTeamIdForRoleReadMock.mockRejectedValue(new Error("boom"))

    await expect(
      inviteMemberToOrg(client, {
        org: "acme",
        row: row({
          classrooms: [
            {
              classroom: "cs101",
              archived: false,
              section: "",
              state: "enrolled",
            },
          ],
        }),
      }),
    ).rejects.toThrow("boom")
    expect(ensureOrgMembershipMock).not.toHaveBeenCalled()
    expect(createOrgInvitationMock).not.toHaveBeenCalled()
  })

  it("resolves each classroom's team once per run through a shared cache", async () => {
    resolveTeamIdForRoleReadMock.mockResolvedValue(1001)
    const teamIdCache = new Map()
    const classrooms = [
      { classroom: "cs101", archived: false, section: "", state: "enrolled" },
    ] as const
    await inviteMemberToOrg(client, {
      org: "acme",
      row: row({ classrooms: [...classrooms] }),
      teamIdCache,
    })
    await inviteMemberToOrg(client, {
      org: "acme",
      row: row({ classrooms: [...classrooms] }),
      teamIdCache,
    })

    expect(resolveTeamIdForRoleReadMock).toHaveBeenCalledTimes(1)
    expect(ensureOrgMembershipMock.mock.calls[1]?.[1]).toMatchObject({
      teamIds: [1001],
    })
  })

  it("dismisses the attributed failed record only after the invite went out", async () => {
    await inviteMemberToOrg(client, {
      org: "acme",
      row: row({
        failed_invitation: {
          id: 79153763,
          kind: "expired",
          failed_at: null,
          reason: null,
        },
      }),
    })

    expect(dismissFailedInvitationMock).toHaveBeenCalledWith(client, {
      org: "acme",
      invitationId: 79153763,
    })
    expect(
      dismissFailedInvitationMock.mock.invocationCallOrder[0],
    ).toBeGreaterThan(ensureOrgMembershipMock.mock.invocationCallOrder[0]!)
  })

  it("keeps the failed record when the send throws", async () => {
    ensureOrgMembershipMock.mockRejectedValue(new Error("500"))

    await expect(
      inviteMemberToOrg(client, {
        org: "acme",
        row: row({
          failed_invitation: {
            id: 79153763,
            kind: "expired",
            failed_at: null,
            reason: null,
          },
        }),
      }),
    ).rejects.toThrow()
    expect(dismissFailedInvitationMock).not.toHaveBeenCalled()
  })

  it("reports an existing pending/active state instead of claiming a send", async () => {
    ensureOrgMembershipMock.mockResolvedValue({ state: "pending" })
    await expect(
      inviteMemberToOrg(client, { org: "acme", row: row({}) }),
    ).resolves.toMatchObject({ state: "pending" })
  })

  it("falls back to a direct send when no login is known to precheck with", async () => {
    getUserByIdMock.mockRejectedValue(new Error("404"))

    const result = await inviteMemberToOrg(client, {
      org: "acme",
      row: row({ username: "" }),
    })

    expect(ensureOrgMembershipMock).not.toHaveBeenCalled()
    expect(createOrgInvitationMock).toHaveBeenCalledWith(client, {
      org: "acme",
      invitee_id: 42,
      team_ids: undefined,
    })
    expect(result).toEqual({ currentUsername: undefined, state: "invited" })
  })

  it("still invites when the current-login lookup fails but the row has a username", async () => {
    getUserByIdMock.mockRejectedValue(new Error("404"))

    const result = await inviteMemberToOrg(client, {
      org: "acme",
      row: row({}),
    })

    expect(ensureOrgMembershipMock.mock.calls[0]?.[1]).toMatchObject({
      username: "old-handle",
    })
    expect(result.currentUsername).toBeUndefined()
    expect(result.state).toBe("invited")
  })

  it("throws when the row has no usable github_id", async () => {
    await expect(
      inviteMemberToOrg(client, { org: "acme", row: row({ github_id: "" }) }),
    ).rejects.toThrow(/no GitHub id/i)
    expect(ensureOrgMembershipMock).not.toHaveBeenCalled()
    expect(createOrgInvitationMock).not.toHaveBeenCalled()
  })

  // "1e3" once coerced to invitee_id 1000 — an unrelated account. The message
  // must name the bad cell, since "no GitHub id on file" would send the teacher
  // to re-add a student whose row is present but corrupt.
  it("names the offending cell for a malformed github_id", async () => {
    await expect(
      inviteMemberToOrg(client, {
        org: "acme",
        row: row({ github_id: "1e3" }),
      }),
    ).rejects.toThrow(/"1e3" isn't a valid GitHub id/)
    expect(ensureOrgMembershipMock).not.toHaveBeenCalled()
  })
})
