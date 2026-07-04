import { describe, expect, it, vi } from "vitest"

import { removeMemberFromOrg } from "./removeMemberFromOrg"
import type { OrgMemberRow } from "@/util/orgMembers"

// unenrollStudent and removeOrgMembership are stubbed: this helper's contract is
// the SEQUENCE (unenroll every roster, then remove org membership last) and its
// warning accumulation, not the underlying GitHub calls.
const unenrollMock = vi.fn()
const removeOrgMembershipMock = vi.fn()
const getAuthenticatedUserMock = vi.fn()

vi.mock("@/api/mutations/students", () => ({
  unenrollStudent: (...args: unknown[]) => unenrollMock(...args),
}))
vi.mock("@/hooks/github/mutations", () => ({
  removeOrgMembership: (...args: unknown[]) => removeOrgMembershipMock(...args),
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}))
vi.mock("@/api/queries/users", () => ({
  getAuthenticatedUser: (...args: unknown[]) =>
    getAuthenticatedUserMock(...args),
}))

const client = {} as never

const row = (over: Partial<OrgMemberRow>): OrgMemberRow => ({
  key: "42",
  username: "alice",
  github_id: "42",
  name: "Alice",
  email: "alice@x.edu",
  isMember: true,
  classrooms: [],
  classification: "member-on-roster",
  ...over,
})

const access = (classroom: string) => ({
  classroom,
  archived: false,
  enrollment_status: "enrolled" as const,
  section: "",
})

describe("removeMemberFromOrg", () => {
  // Default: the signed-in viewer is someone else, so the self-guard never trips.
  const otherViewer = { id: 999, login: "teacher" }

  it("unenrolls every roster first, then removes org membership last", async () => {
    const calls: string[] = []
    getAuthenticatedUserMock.mockReset().mockResolvedValue(otherViewer)
    unenrollMock.mockReset().mockImplementation((_c, input) => {
      calls.push(`unenroll:${input.classroom}`)
      return Promise.resolve({})
    })
    removeOrgMembershipMock.mockReset().mockImplementation(() => {
      calls.push("removeOrg")
      return Promise.resolve()
    })

    const result = await removeMemberFromOrg(client, {
      org: "acme",
      row: row({ classrooms: [access("cs101"), access("cs201")] }),
    })

    expect(calls).toEqual(["unenroll:cs101", "unenroll:cs201", "removeOrg"])
    expect(result.unenrolledClassrooms).toEqual(["cs101", "cs201"])
    expect(result.removed).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it("continues and still removes org membership when one unenroll fails", async () => {
    getAuthenticatedUserMock.mockReset().mockResolvedValue(otherViewer)
    unenrollMock
      .mockReset()
      .mockImplementationOnce(() => Promise.reject(new Error("boom")))
      .mockImplementation(() => Promise.resolve({}))
    removeOrgMembershipMock.mockReset().mockResolvedValue(undefined)

    const result = await removeMemberFromOrg(client, {
      org: "acme",
      row: row({ classrooms: [access("cs101"), access("cs201")] }),
    })

    expect(result.unenrolledClassrooms).toEqual(["cs201"])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/cs101/)
    expect(removeOrgMembershipMock).toHaveBeenCalledTimes(1)
    expect(result.removed).toBe(true)
  })

  it("removes a member on no roster with zero unenroll calls", async () => {
    getAuthenticatedUserMock.mockReset().mockResolvedValue(otherViewer)
    unenrollMock.mockReset()
    removeOrgMembershipMock.mockReset().mockResolvedValue(undefined)

    const result = await removeMemberFromOrg(client, {
      org: "acme",
      row: row({ classrooms: [], classification: "member-no-roster" }),
    })

    expect(unenrollMock).not.toHaveBeenCalled()
    expect(removeOrgMembershipMock).toHaveBeenCalledTimes(1)
    expect(result.removed).toBe(true)
  })

  it("skips archived classrooms (can't unenroll) but still removes org membership", async () => {
    getAuthenticatedUserMock.mockReset().mockResolvedValue(otherViewer)
    unenrollMock.mockReset().mockResolvedValue({})
    removeOrgMembershipMock.mockReset().mockResolvedValue(undefined)

    const result = await removeMemberFromOrg(client, {
      org: "acme",
      row: row({
        classrooms: [access("cs101"), { ...access("cs-old"), archived: true }],
      }),
    })

    // unenroll only fires for the active classroom; the archived one is skipped.
    expect(unenrollMock).toHaveBeenCalledTimes(1)
    expect(result.unenrolledClassrooms).toEqual(["cs101"])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/cs-old/)
    expect(removeOrgMembershipMock).toHaveBeenCalledTimes(1)
    expect(result.removed).toBe(true)
  })

  it("warns and skips the org DELETE for a member with no GitHub username", async () => {
    getAuthenticatedUserMock.mockReset().mockResolvedValue(otherViewer)
    unenrollMock.mockReset().mockResolvedValue({})
    removeOrgMembershipMock.mockReset().mockResolvedValue(undefined)

    const result = await removeMemberFromOrg(client, {
      org: "acme",
      row: row({ username: "", email: "x@x.edu", classrooms: [] }),
    })

    expect(removeOrgMembershipMock).not.toHaveBeenCalled()
    expect(result.removed).toBe(false)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/no GitHub username/i)
  })

  it("refuses to remove the signed-in viewer (self-guard, independent of UI)", async () => {
    getAuthenticatedUserMock
      .mockReset()
      .mockResolvedValue({ id: 42, login: "alice" })
    unenrollMock.mockReset()
    removeOrgMembershipMock.mockReset()

    await expect(
      removeMemberFromOrg(client, {
        org: "acme",
        row: row({ github_id: "42", username: "alice" }),
      }),
    ).rejects.toThrow(/your own account/i)
    expect(unenrollMock).not.toHaveBeenCalled()
    expect(removeOrgMembershipMock).not.toHaveBeenCalled()
  })

  it("fails closed when the viewer can't be resolved (no self-lockout)", async () => {
    getAuthenticatedUserMock.mockReset().mockRejectedValue(new Error("401"))
    unenrollMock.mockReset()
    removeOrgMembershipMock.mockReset()

    await expect(
      removeMemberFromOrg(client, {
        org: "acme",
        row: row({ classrooms: [access("cs101")] }),
      }),
    ).rejects.toThrow(/verify your account/i)
    expect(unenrollMock).not.toHaveBeenCalled()
    expect(removeOrgMembershipMock).not.toHaveBeenCalled()
  })

  it("reports a non-fatal warning when the org-membership removal fails", async () => {
    getAuthenticatedUserMock.mockReset().mockResolvedValue(otherViewer)
    unenrollMock.mockReset()
    removeOrgMembershipMock
      .mockReset()
      .mockRejectedValue(new Error("503 service unavailable"))

    const result = await removeMemberFromOrg(client, {
      org: "acme",
      row: row({ github_id: "42", classrooms: [] }),
    })

    expect(result.removed).toBe(false)
    expect(result.warnings.some((w) => /organization failed/i.test(w))).toBe(
      true,
    )
  })
})
