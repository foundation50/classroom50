import { describe, expect, it, vi } from "vitest"

import { inviteMemberToOrg } from "./inviteMemberToOrg"
import type { OrgMemberRow } from "@/util/orgMembers"

const createOrgInvitationMock = vi.fn()
const getUserByIdMock = vi.fn()

vi.mock("@/github-core/mutations", () => ({
  createOrgInvitation: (...args: unknown[]) => createOrgInvitationMock(...args),
}))
vi.mock("@/github-core/errorMessage", () => ({
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}))
vi.mock("@/github-core/queries", () => ({
  getUserById: (...args: unknown[]) => getUserByIdMock(...args),
}))

const client = {} as never

const row = (over: Partial<OrgMemberRow>): OrgMemberRow => ({
  key: "42",
  username: "old-handle",
  github_id: "42",
  name: "Alice",
  email: "alice@x.edu",
  isMember: false,
  classrooms: [],
  classification: "on-roster-not-member",
  unprovisionedClassrooms: [],
  ...over,
})

describe("inviteMemberToOrg", () => {
  it("invites by numeric github_id, not by the (possibly stale) username", async () => {
    createOrgInvitationMock.mockReset().mockResolvedValue({})
    getUserByIdMock.mockReset().mockResolvedValue({ login: "new-handle" })

    const result = await inviteMemberToOrg(client, {
      org: "acme",
      row: row({ github_id: "42", username: "old-handle" }),
    })

    expect(createOrgInvitationMock).toHaveBeenCalledWith(client, {
      org: "acme",
      invitee_id: 42,
    })
    expect(result.invited).toBe(true)
    // Current login resolved from the immutable id.
    expect(result.currentUsername).toBe("new-handle")
  })

  it("still invites when the current-login lookup fails", async () => {
    createOrgInvitationMock.mockReset().mockResolvedValue({})
    getUserByIdMock.mockReset().mockRejectedValue(new Error("404"))

    const result = await inviteMemberToOrg(client, {
      org: "acme",
      row: row({}),
    })

    expect(createOrgInvitationMock).toHaveBeenCalledTimes(1)
    expect(result.invited).toBe(true)
    expect(result.currentUsername).toBeUndefined()
  })

  it("throws when the row has no usable github_id", async () => {
    createOrgInvitationMock.mockReset()
    getUserByIdMock.mockReset()

    await expect(
      inviteMemberToOrg(client, { org: "acme", row: row({ github_id: "" }) }),
    ).rejects.toThrow(/no GitHub id/i)
    expect(createOrgInvitationMock).not.toHaveBeenCalled()
  })

  // "1e3" once coerced to invitee_id 1000 — an unrelated account. The message
  // must name the bad cell, since "no GitHub id on file" would send the teacher
  // to re-add a student whose row is present but corrupt.
  it("names the offending cell for a malformed github_id", async () => {
    createOrgInvitationMock.mockReset()
    getUserByIdMock.mockReset()

    await expect(
      inviteMemberToOrg(client, {
        org: "acme",
        row: row({ github_id: "1e3" }),
      }),
    ).rejects.toThrow(/"1e3" isn't a valid GitHub id/)
    expect(createOrgInvitationMock).not.toHaveBeenCalled()
  })
})
