import { beforeEach, describe, expect, it, vi } from "vitest"

import { bulkAddToClassroom } from "./bulkAddToClassroom"
import type { OrgMemberRow } from "@/util/orgMembers"
import type { GitHubUser } from "@/github-core/types"

// The engine (bulkEnrollStudentsInClassroom), getUserById, and isActiveMember
// are stubbed: this orchestrator's contract is the pre-filter, resolving the
// current login by id, re-verifying live membership, and how it feeds the
// engine — not the engine's own CSV/team work.
const bulkEnrollMock = vi.fn()
const getUserByIdMock = vi.fn()
const isActiveMemberMock = vi.fn()

vi.mock("@/domain/students", () => ({
  bulkEnrollStudentsInClassroom: (...args: unknown[]) =>
    bulkEnrollMock(...args),
}))
vi.mock("@/github-core/queries", () => ({
  getUserById: (...args: unknown[]) => getUserByIdMock(...args),
}))
vi.mock("@/github-core/mutations", () => ({
  isActiveMember: (...args: unknown[]) => isActiveMemberMock(...args),
}))

const client = {} as never

const row = (over: Partial<OrgMemberRow>): OrgMemberRow => ({
  key: "1",
  username: "alice",
  github_id: "1",
  name: "Alice",
  email: "alice@x.edu",
  isMember: true,
  classrooms: [],
  classification: "member-on-roster",
  unprovisionedClassrooms: [],
  ...over,
})

const member = (id: number, login: string): GitHubUser =>
  ({ id, login }) as GitHubUser

const access = (classroom: string) => ({
  classroom,
  archived: false,
  section: "",
  state: "enrolled" as const,
})

describe("bulkAddToClassroom", () => {
  beforeEach(() => {
    // Default: resolved accounts are live active members. Individual tests
    // override for the since-removed / stale-snapshot case.
    isActiveMemberMock.mockReset().mockResolvedValue(true)
  })

  it("resolves live members to current logins and feeds the engine", async () => {
    getUserByIdMock
      .mockReset()
      .mockImplementation((_c, id: number) =>
        Promise.resolve({ login: `user${id}` }),
      )
    bulkEnrollMock.mockReset().mockResolvedValue({
      addedStudents: [],
      skippedStudents: [],
      teamResults: [],
    })

    await bulkAddToClassroom(client, {
      org: "acme",
      classroom: "cs101",
      rows: [
        row({ key: "1", github_id: "1" }),
        row({ key: "2", github_id: "2" }),
      ],
      members: [member(1, "alice"), member(2, "bob")],
    })

    expect(bulkEnrollMock).toHaveBeenCalledTimes(1)
    const call = bulkEnrollMock.mock.calls[0][1]
    expect(call.usernames).toEqual(["user1", "user2"])
    expect(call.classroom).toBe("cs101")
  })

  it("skips non-members (never invites) and reports them", async () => {
    getUserByIdMock.mockReset().mockResolvedValue({ login: "alice" })
    bulkEnrollMock.mockReset().mockResolvedValue({
      addedStudents: [],
      skippedStudents: [],
      teamResults: [],
    })

    const res = await bulkAddToClassroom(client, {
      org: "acme",
      classroom: "cs101",
      rows: [
        row({ key: "1", github_id: "1", username: "alice" }),
        row({
          key: "99",
          github_id: "99",
          username: "ghost",
          isMember: false,
          classification: "on-roster-not-member",
        }),
      ],
      members: [member(1, "alice")],
    })

    expect(bulkEnrollMock.mock.calls[0][1].usernames).toEqual(["alice"])
    expect(res.preSkipped).toHaveLength(1)
    expect(res.preSkipped[0]).toMatchObject({ key: "99", reason: "not-member" })
  })

  it("reports an isMember row that resolves to no member id as 'no-id'", async () => {
    // isMember:true but neither github_id nor username matches a loaded member,
    // so matchedId stays null on the isMember branch. Engine never called.
    getUserByIdMock.mockReset()
    bulkEnrollMock.mockReset()

    const res = await bulkAddToClassroom(client, {
      org: "acme",
      classroom: "cs101",
      rows: [
        row({
          key: "42",
          github_id: "42",
          username: "renamed-away",
          isMember: true,
        }),
      ],
      // The loaded member list contains a different account entirely.
      members: [member(1, "alice")],
    })

    expect(bulkEnrollMock).not.toHaveBeenCalled()
    expect(res.enroll).toBeNull()
    expect(res.preSkipped).toHaveLength(1)
    expect(res.preSkipped[0]).toMatchObject({ key: "42", reason: "no-id" })
  })

  it("skips members already on the target classroom", async () => {
    getUserByIdMock.mockReset().mockResolvedValue({ login: "alice" })
    bulkEnrollMock.mockReset()

    const res = await bulkAddToClassroom(client, {
      org: "acme",
      classroom: "cs101",
      rows: [row({ key: "1", github_id: "1", classrooms: [access("cs101")] })],
      members: [member(1, "alice")],
    })

    // Nothing eligible -> engine never called.
    expect(bulkEnrollMock).not.toHaveBeenCalled()
    expect(res.enroll).toBeNull()
    expect(res.preSkipped[0]).toMatchObject({
      reason: "already-on-classroom",
    })
  })

  it("matches a member by login when the row github_id is stale", async () => {
    getUserByIdMock.mockReset().mockResolvedValue({ login: "alice-new" })
    bulkEnrollMock.mockReset().mockResolvedValue({
      addedStudents: [],
      skippedStudents: [],
      teamResults: [],
    })

    await bulkAddToClassroom(client, {
      org: "acme",
      classroom: "cs101",
      // Row's github_id 999 isn't a live member, but its login is (id 1).
      rows: [row({ key: "1", github_id: "999", username: "alice" })],
      members: [member(1, "alice")],
    })

    // Resolved via the login->id fallback (id 1), not the stale 999.
    expect(getUserByIdMock).toHaveBeenCalledWith(client, 1)
    expect(bulkEnrollMock.mock.calls[0][1].usernames).toEqual(["alice-new"])
  })

  it("reports a resolve failure without enrolling a stale login", async () => {
    getUserByIdMock.mockReset().mockRejectedValue(new Error("404"))
    bulkEnrollMock.mockReset()

    const res = await bulkAddToClassroom(client, {
      org: "acme",
      classroom: "cs101",
      rows: [row({ key: "1", github_id: "1", username: "alice" })],
      members: [member(1, "alice")],
    })

    expect(bulkEnrollMock).not.toHaveBeenCalled()
    expect(res.preSkipped[0]).toMatchObject({ reason: "resolve-failed" })
  })

  it("skips a since-removed member (stale loaded list) after the live re-check", async () => {
    // Passes the loaded-list pre-filter, resolves a login, but the live re-check
    // says they're no longer an active member.
    getUserByIdMock.mockReset().mockResolvedValue({ login: "alice" })
    isActiveMemberMock.mockReset().mockResolvedValue(false)
    bulkEnrollMock.mockReset()

    const res = await bulkAddToClassroom(client, {
      org: "acme",
      classroom: "cs101",
      rows: [row({ key: "1", github_id: "1", username: "alice" })],
      members: [member(1, "alice")],
    })

    // Never enrolled -> no CSV drift row for a non-member.
    expect(bulkEnrollMock).not.toHaveBeenCalled()
    expect(res.enroll).toBeNull()
    expect(res.preSkipped[0]).toMatchObject({ key: "1", reason: "not-member" })
  })
})
