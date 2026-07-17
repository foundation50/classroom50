// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"

const bulkEnrollStudentsInClassroom =
  vi.fn<(...args: unknown[]) => Promise<unknown>>()
const inviteRosterStudents = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const writeClassroomRoles = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const applyClassroomRoleChange =
  vi.fn<(...args: unknown[]) => Promise<unknown>>()

vi.mock("@/domain/students", () => {
  // Declared inside the (hoisted) factory so they exist when the mock evaluates.
  class NoNewStudentsError extends Error {}
  class RosterCsvMalformedError extends Error {}
  return {
    bulkEnrollStudentsInClassroom: (...a: unknown[]) =>
      bulkEnrollStudentsInClassroom(...a),
    inviteRosterStudents: (...a: unknown[]) => inviteRosterStudents(...a),
    writeClassroomRoles: (...a: unknown[]) => writeClassroomRoles(...a),
    applyClassroomRoleChange: (...a: unknown[]) =>
      applyClassroomRoleChange(...a),
    NoNewStudentsError,
    RosterCsvMalformedError,
  }
})

// Pull the error classes back from the mocked module so tests throw the exact
// constructors runRosterImport's instanceof checks compare against.
const { NoNewStudentsError, RosterCsvMalformedError } =
  (await import("@/domain/students")) as unknown as {
    NoNewStudentsError: new (msg?: string) => Error
    RosterCsvMalformedError: new (msg?: string) => Error
  }

import { runRosterImport } from "./runRosterImport"
import type { GitHubClient } from "@/github-core/client"
import type { ImportRosterRow } from "@/domain/students"

const client = {} as unknown as GitHubClient
const messages = {
  startingImport: "starting",
  invitingUploaded: "inviting",
  processRoleChanges: "moving",
  importFailed: "import-failed",
  roleWritebackMalformed: "roleback-malformed",
  roleWritebackFailed: "roleback-failed",
}

const rows: ImportRosterRow[] = [{ username: "alice" }, { username: "bob" }]

const call = (over: Record<string, unknown> = {}) =>
  runRosterImport(client, {
    org: "acme",
    classroom: "cs101",
    rows,
    rolesByUser: { alice: "student", bob: "ta" },
    plan: null,
    onProgress: vi.fn(),
    messages,
    ...over,
  })

beforeEach(() => {
  vi.clearAllMocks()
  bulkEnrollStudentsInClassroom.mockResolvedValue({
    addedStudents: [{ username: "alice", github_id: "1" }],
    skippedStudents: [],
  })
  inviteRosterStudents.mockResolvedValue({
    invited: [{ username: "alice", role: "student" }],
    deferred: [],
    failed: [],
  })
  writeClassroomRoles.mockResolvedValue(undefined)
  applyClassroomRoleChange.mockImplementation((...args: unknown[]) => {
    const input = args[1] as { username: string; toRole: string }
    return Promise.resolve({
      username: input.username,
      toRole: input.toRole,
      warnings: [],
    })
  })
})

describe("runRosterImport — happy path", () => {
  it("enrolls, invites, writes back roles, and reports the outcome", async () => {
    const out = await call()
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(bulkEnrollStudentsInClassroom).toHaveBeenCalledOnce()
    expect(inviteRosterStudents).toHaveBeenCalledOnce()
    expect(writeClassroomRoles).toHaveBeenCalledOnce()
    expect(out.inviteOutcome?.invited).toEqual([
      { username: "alice", role: "student" },
    ])
    expect(out.inviteError).toBeNull()
  })
})

describe("runRosterImport — enroll failures", () => {
  it("falls through NoNewStudentsError to the invite pass with an empty result", async () => {
    bulkEnrollStudentsInClassroom.mockRejectedValueOnce(
      new NoNewStudentsError("none"),
    )
    const out = await call()
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.importResult.addedStudents).toEqual([])
    // The invite pass still runs so a previously-deferred student is re-invited.
    expect(inviteRosterStudents).toHaveBeenCalledOnce()
  })

  it("returns ok:false on a hard enroll failure (nothing written)", async () => {
    bulkEnrollStudentsInClassroom.mockRejectedValueOnce(new Error("boom"))
    const out = await call()
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toBe("boom")
    expect(inviteRosterStudents).not.toHaveBeenCalled()
  })
})

describe("runRosterImport — invite + writeback soft failures", () => {
  it("keeps ok:true and surfaces inviteError when the invite pass throws", async () => {
    inviteRosterStudents.mockRejectedValueOnce(new Error("invite-boom"))
    const out = await call()
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.inviteError).toBe("invite-boom")
  })

  it("maps a malformed roster.csv writeback to the malformed message", async () => {
    writeClassroomRoles.mockRejectedValueOnce(
      new RosterCsvMalformedError("bad"),
    )
    const out = await call()
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.inviteError).toBe("roleback-malformed")
  })

  it("maps a generic writeback failure to the soft-warning message", async () => {
    writeClassroomRoles.mockRejectedValueOnce(new Error("transient"))
    const out = await call()
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.inviteError).toBe("roleback-failed")
  })
})

describe("runRosterImport — allAlreadyMembers skips invites", () => {
  it("does not call the invite endpoint when every row is already a member", async () => {
    const out = await call({
      plan: {
        allAlreadyMembers: true,
        needsInvite: [],
        enroll: [],
        roleChanges: [],
        noAction: rows.map((r) => ({ username: r.username })),
      },
    })
    expect(out.ok).toBe(true)
    expect(inviteRosterStudents).not.toHaveBeenCalled()
  })
})

describe("runRosterImport — confirmed team moves", () => {
  it("applies role changes + enrolls from the plan and reports them", async () => {
    const out = await call({
      plan: {
        allAlreadyMembers: false,
        needsInvite: [],
        noAction: [],
        roleChanges: [
          { username: "carol", currentRoles: ["student"], role: "ta" },
        ],
        enroll: [{ username: "dave", role: "student" }],
      },
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(applyClassroomRoleChange).toHaveBeenCalledTimes(2)
    expect(out.roleChangeOutcome?.changed).toEqual([
      { username: "carol", to: "ta" },
      { username: "dave", to: "student" },
    ])
  })

  it("reports a per-move failure without aborting the batch", async () => {
    applyClassroomRoleChange
      .mockRejectedValueOnce(new Error("move-boom"))
      .mockResolvedValueOnce({
        username: "dave",
        toRole: "student",
        warnings: [],
      })
    const out = await call({
      plan: {
        allAlreadyMembers: false,
        needsInvite: [],
        noAction: [],
        roleChanges: [
          { username: "carol", currentRoles: ["student"], role: "ta" },
        ],
        enroll: [{ username: "dave", role: "student" }],
      },
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.roleChangeOutcome?.failed).toEqual([
      { username: "carol", message: "move-boom" },
    ])
    expect(out.roleChangeOutcome?.changed).toEqual([
      { username: "dave", to: "student" },
    ])
  })
})
