import { describe, expect, it, vi } from "vitest"

import { bulkRemoveFromClassroom } from "./bulkRemoveFromClassroom"
import type { OrgMemberRow } from "@/util/orgMembers"
import type { Student } from "@/types/classroom"

// bulkUnenrollStudents (the single-commit batch writer) is stubbed: this
// orchestrator's contract is the per-row PRE-filter (only rows on the target,
// non-archived classroom reach the writer) and reconciling the batch result to
// per-row outcomes.
const bulkUnenrollMock = vi.fn()

vi.mock("@/domain/students", () => ({
  bulkUnenrollStudents: (...args: unknown[]) => bulkUnenrollMock(...args),
}))
vi.mock("@/github-core/errorMessage", () => ({
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
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

const access = (classroom: string, archived = false) => ({
  classroom,
  archived,
  section: "",
  state: "enrolled" as const,
})

describe("bulkRemoveFromClassroom", () => {
  it("sends all eligible rows to the batch writer in one call", async () => {
    // Echo the students back as "removed" so every eligible row reconciles.
    bulkUnenrollMock.mockReset().mockImplementation((_c, input) =>
      Promise.resolve({
        removed: input.students as Student[],
        notFound: [],
        warnings: [],
      }),
    )

    const res = await bulkRemoveFromClassroom(client, {
      org: "acme",
      classroom: "cs101",
      rows: [
        row({ key: "1", classrooms: [access("cs101")] }),
        row({ key: "2", username: "bob", classrooms: [access("cs101")] }),
      ],
    })

    // ONE batch call, not one per student.
    expect(bulkUnenrollMock).toHaveBeenCalledTimes(1)
    expect(bulkUnenrollMock.mock.calls[0][1].students).toHaveLength(2)
    expect(res.removedCount).toBe(2)
    expect(res.outcomes.every((o) => o.status === "removed")).toBe(true)
  })

  it("reconciles by identity when the writer returns normalized copies (not the same refs)", async () => {
    // The writer returns fresh Student objects (as a real normalize would),
    // sharing only identity fields. Reconcile must still mark the row removed.
    bulkUnenrollMock.mockReset().mockImplementation((_c, input) =>
      Promise.resolve({
        removed: (input.students as Student[]).map((s) => ({ ...s })),
        notFound: [],
        warnings: [],
      }),
    )

    const res = await bulkRemoveFromClassroom(client, {
      org: "acme",
      classroom: "cs101",
      rows: [row({ key: "1", classrooms: [access("cs101")] })],
    })

    expect(res.removedCount).toBe(1)
    expect(res.outcomes[0]).toMatchObject({ key: "1", status: "removed" })
  })

  it("labels an eligible row the writer reports as gone 'already-removed', not 'not-on-classroom'", async () => {
    // Passed the pre-filter (on the classroom) but absent from the CSV at write
    // time (a racing edit / prior removal).
    bulkUnenrollMock
      .mockReset()
      .mockResolvedValue({ removed: [], notFound: [], warnings: [] })

    const res = await bulkRemoveFromClassroom(client, {
      org: "acme",
      classroom: "cs101",
      rows: [row({ key: "1", classrooms: [access("cs101")] })],
    })

    expect(res.outcomes[0]).toMatchObject({
      key: "1",
      status: "skipped",
      detail: "already-removed",
    })
  })

  it("skips a row not on the target classroom (never sent to the writer)", async () => {
    bulkUnenrollMock
      .mockReset()
      .mockResolvedValue({ removed: [], notFound: [], warnings: [] })

    const res = await bulkRemoveFromClassroom(client, {
      org: "acme",
      classroom: "cs101",
      rows: [row({ key: "1", classrooms: [access("cs201")] })],
    })

    expect(bulkUnenrollMock).not.toHaveBeenCalled()
    expect(res.outcomes[0]).toMatchObject({
      status: "skipped",
      detail: "not-on-classroom",
    })
  })

  it("skips an archived target (can't unenroll)", async () => {
    bulkUnenrollMock
      .mockReset()
      .mockResolvedValue({ removed: [], notFound: [], warnings: [] })

    const res = await bulkRemoveFromClassroom(client, {
      org: "acme",
      classroom: "cs-old",
      rows: [row({ key: "1", classrooms: [access("cs-old", true)] })],
    })

    expect(bulkUnenrollMock).not.toHaveBeenCalled()
    expect(res.outcomes[0]).toMatchObject({
      status: "skipped",
      detail: "archived",
    })
  })

  it("surfaces per-student side-effect warnings from the writer", async () => {
    bulkUnenrollMock.mockReset().mockImplementation((_c, input) =>
      Promise.resolve({
        removed: input.students as Student[],
        notFound: [],
        warnings: ["bob: team drop failed"],
      }),
    )

    const res = await bulkRemoveFromClassroom(client, {
      org: "acme",
      classroom: "cs101",
      rows: [row({ key: "1", classrooms: [access("cs101")] })],
    })

    expect(res.warnings).toEqual(["bob: team drop failed"])
  })

  it("marks every eligible row failed when the single roster write throws", async () => {
    bulkUnenrollMock.mockReset().mockRejectedValue(new Error("409 conflict"))

    const res = await bulkRemoveFromClassroom(client, {
      org: "acme",
      classroom: "cs101",
      rows: [
        row({ key: "1", classrooms: [access("cs101")] }),
        row({ key: "2", username: "bob", classrooms: [access("cs101")] }),
      ],
    })

    expect(res.removedCount).toBe(0)
    expect(res.outcomes.every((o) => o.status === "failed")).toBe(true)
    expect(res.outcomes[0].detail).toMatch(/409/)
  })
})
