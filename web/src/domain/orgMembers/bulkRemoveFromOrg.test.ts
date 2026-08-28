import { describe, expect, it, vi, beforeEach } from "vitest"

import { bulkRemoveFromOrg } from "./bulkRemoveFromOrg"
import type { OrgMemberRow } from "@/util/orgMembers"

// removeMemberFromOrg is stubbed: this orchestrator's contract is the per-row
// pre-filtering (self / no-username), the single up-front viewer resolution,
// and the outcome/warning reconciliation — not the removal sequence itself
// (covered by removeMemberFromOrg.test.ts).
const removeMemberMock = vi.fn()
const getAuthenticatedUserMock = vi.fn()

vi.mock("@/domain/orgMembers/removeMemberFromOrg", () => ({
  removeMemberFromOrg: (...args: unknown[]) => removeMemberMock(...args),
}))
vi.mock("@/domain/queries/users", () => ({
  getAuthenticatedUser: (...args: unknown[]) =>
    getAuthenticatedUserMock(...args),
}))
vi.mock("@/github-core/errorMessage", () => ({
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}))

const client = {} as never
const viewer = { id: 999, login: "teacher" }

const row = (over: Partial<OrgMemberRow>): OrgMemberRow => ({
  key: over.username || "k",
  username: "alice",
  github_id: "42",
  name: "",
  email: "",
  emails: [],
  isMember: true,
  classrooms: [],
  classification: "member-on-roster",
  unprovisionedClassrooms: [],
  ...over,
})

beforeEach(() => {
  removeMemberMock.mockReset()
  getAuthenticatedUserMock.mockReset().mockResolvedValue(viewer)
})

describe("bulkRemoveFromOrg", () => {
  it("fails closed when the viewer can't be resolved (nothing removed)", async () => {
    getAuthenticatedUserMock.mockReset().mockRejectedValue(new Error("401"))

    await expect(
      bulkRemoveFromOrg(client, { org: "acme", rows: [row({})] }),
    ).rejects.toThrow(/verify your account/i)
    expect(removeMemberMock).not.toHaveBeenCalled()
  })

  it("resolves the viewer once and passes it through to each removal", async () => {
    removeMemberMock.mockResolvedValue({
      unenrolledClassrooms: [],
      warnings: [],
      removed: true,
    })

    await bulkRemoveFromOrg(client, {
      org: "acme",
      rows: [
        row({ username: "a", key: "a" }),
        row({ username: "b", key: "b" }),
      ],
    })

    expect(getAuthenticatedUserMock).toHaveBeenCalledTimes(1)
    expect(removeMemberMock).toHaveBeenCalledTimes(2)
    expect(removeMemberMock.mock.calls[0][1]).toMatchObject({ viewer })
  })

  it("skips the signed-in account and a username-less row without calling removal", async () => {
    removeMemberMock.mockResolvedValue({
      unenrolledClassrooms: [],
      warnings: [],
      removed: true,
    })

    const result = await bulkRemoveFromOrg(client, {
      org: "acme",
      rows: [
        row({ username: "teacher", github_id: "999", key: "self" }),
        row({ username: "", email: "x@x.edu", key: "email-only" }),
        row({ username: "alice", key: "alice" }),
      ],
    })

    expect(removeMemberMock).toHaveBeenCalledTimes(1)
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        key: "self",
        status: "skipped",
        detail: "self",
      }),
      expect.objectContaining({
        key: "email-only",
        status: "skipped",
        detail: "no-username",
      }),
      expect.objectContaining({ key: "alice", status: "removed" }),
    ])
    expect(result.removedCount).toBe(1)
  })

  it("accumulates per-member warnings and unenrolled classrooms", async () => {
    removeMemberMock
      .mockResolvedValueOnce({
        unenrolledClassrooms: ["cs101", "cs201"],
        warnings: ["archived warning"],
        removed: true,
      })
      .mockResolvedValueOnce({
        unenrolledClassrooms: [],
        warnings: [],
        removed: true,
      })

    const result = await bulkRemoveFromOrg(client, {
      org: "acme",
      rows: [
        row({ username: "a", key: "a" }),
        row({ username: "b", key: "b" }),
      ],
    })

    expect(result.warnings).toEqual(["archived warning"])
    expect(result.outcomes[0].unenrolledClassrooms).toEqual(["cs101", "cs201"])
    expect(result.removedCount).toBe(2)
  })

  it("marks a failed org DELETE as failed and keeps processing the rest", async () => {
    removeMemberMock
      .mockResolvedValueOnce({
        unenrolledClassrooms: ["cs101"],
        warnings: ["Removing a from the organization failed (503)"],
        removed: false,
      })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        unenrolledClassrooms: [],
        warnings: [],
        removed: true,
      })

    const result = await bulkRemoveFromOrg(client, {
      org: "acme",
      rows: [
        row({ username: "a", key: "a" }),
        row({ username: "b", key: "b" }),
        row({ username: "c", key: "c" }),
      ],
    })

    expect(result.outcomes.map((o) => o.status)).toEqual([
      "failed",
      "failed",
      "removed",
    ])
    expect(result.outcomes[0].detail).toMatch(/failed/)
    expect(result.outcomes[1].detail).toBe("boom")
    expect(result.removedCount).toBe(1)
  })

  it("reports progress once per row, including skipped ones", async () => {
    removeMemberMock.mockResolvedValue({
      unenrolledClassrooms: [],
      warnings: [],
      removed: true,
    })
    const onProgress = vi.fn()

    await bulkRemoveFromOrg(client, {
      org: "acme",
      rows: [
        row({ username: "", email: "x@x.edu", key: "email-only" }),
        row({ username: "alice", key: "alice" }),
      ],
      onProgress,
    })

    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(onProgress).toHaveBeenLastCalledWith({
      processed: 2,
      total: 2,
      message: "alice",
    })
  })
})
