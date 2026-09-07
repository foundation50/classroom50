import { describe, expect, it } from "vitest"
import {
  groupStudentsBySection,
  groupStudentsByRole,
  nextSelectedKeyAfterSave,
  rosterSyncMessageKeys,
} from "./enrolledStudentsHelpers"
import type { Student } from "@/types/classroom"
import type { ClassroomRole } from "@/util/teamRoster"

const student = (username: string, section?: string): Student =>
  ({ username, section }) as Student

const syncResult = (over: {
  addedUsernames?: string[]
  recoveredEmails?: string[]
  noop?: boolean
}) => ({
  addedUsernames: over.addedUsernames ?? [],
  recoveredEmails: over.recoveredEmails ?? [],
  noop: over.noop ?? false,
})

describe("rosterSyncMessageKeys", () => {
  // The bug this guards: one pass can complete an accepted email invitation
  // without appending anyone, which reported "Added 0 team members".
  it("reports a matched invite without an added-member count", () => {
    expect(
      rosterSyncMessageKeys(syncResult({ recoveredEmails: ["a@x.edu"] })),
    ).toEqual([{ key: "students.syncMatchedEmails", count: 1 }])
  })

  it("reports every part of a combined pass, in announcement order", () => {
    expect(
      rosterSyncMessageKeys(
        syncResult({
          addedUsernames: ["octocat", "hubot"],
          recoveredEmails: ["a@x.edu"],
        }),
      ),
    ).toEqual([
      { key: "students.syncAdded", count: 2 },
      { key: "students.syncMatchedEmails", count: 1 },
    ])
  })

  it("reports nothing for a no-op pass, so the caller says 'up to date'", () => {
    expect(
      rosterSyncMessageKeys(
        syncResult({ addedUsernames: ["octocat"], noop: true }),
      ),
    ).toEqual([])
  })

  // A commit that only refreshed roles or backfilled ids changes the roster
  // without moving either count; the caller falls back to a generic
  // "Roster updated." rather than claiming zero of something.
  it("reports nothing when a pass committed only role or id changes", () => {
    expect(rosterSyncMessageKeys(syncResult({}))).toEqual([])
  })
})

describe("groupStudentsBySection", () => {
  it("groups by trimmed section name", () => {
    const groups = groupStudentsBySection([
      student("a", "Period 1"),
      student("b", "Period 2"),
      student("c", " Period 1 "),
    ])
    expect(groups.map((g) => g.section)).toEqual(["Period 1", "Period 2"])
    expect(groups[0].students.map((s) => s.username)).toEqual(["a", "c"])
  })

  it("sorts sections numerically/locale-aware", () => {
    const groups = groupStudentsBySection([
      student("a", "Section 10"),
      student("b", "Section 2"),
    ])
    expect(groups.map((g) => g.section)).toEqual(["Section 2", "Section 10"])
  })

  it("folds blank/absent sections into a 'No section' bucket placed last", () => {
    const groups = groupStudentsBySection([
      student("a", ""),
      student("b", "Period 1"),
      student("c"),
    ])
    expect(groups.map((g) => g.section)).toEqual(["Period 1", "No section"])
    expect(groups[1].students.map((s) => s.username)).toEqual(["a", "c"])
  })

  it("returns an empty array for no students", () => {
    expect(groupStudentsBySection([])).toEqual([])
  })
})

describe("groupStudentsByRole", () => {
  const row = (username: string, roles: ClassroomRole[]) => ({
    username,
    roles,
  })

  it("groups by the highest-ranked role, ordered teacher-first", () => {
    const groups = groupStudentsByRole([
      row("s1", ["student"]),
      row("prof", ["teacher"]),
      row("helper", ["ta"]),
      row("s2", ["student"]),
    ])
    expect(groups.map((g) => g.role)).toEqual(["teacher", "ta", "student"])
    expect(groups[2].students.map((s) => s.username)).toEqual(["s1", "s2"])
  })

  it("buckets a multi-role member under their primary role only", () => {
    // A teacher who is also on the student team groups as a teacher — the
    // header matches the row's leading role chip, and no row appears twice.
    const groups = groupStudentsByRole([
      row("prof", ["student", "teacher"]),
      row("s1", ["student"]),
    ])
    expect(groups.map((g) => g.role)).toEqual(["teacher", "student"])
    expect(groups[0].students.map((s) => s.username)).toEqual(["prof"])
    expect(groups[1].students.map((s) => s.username)).toEqual(["s1"])
  })

  it("preserves the incoming (sorted) order inside each group", () => {
    const groups = groupStudentsByRole([
      row("b", ["student"]),
      row("a", ["student"]),
    ])
    expect(groups[0].students.map((s) => s.username)).toEqual(["b", "a"])
  })

  it("returns an empty array for no students", () => {
    expect(groupStudentsByRole([])).toEqual([])
  })
})

describe("nextSelectedKeyAfterSave", () => {
  it("keeps the selection when the key is unchanged (common case)", () => {
    expect(nextSelectedKeyAfterSave("42", "42", "42")).toBe("42")
  })

  it("follows the saved row's selection to its new key so the modal stays open", () => {
    // An email-keyed row whose email was edited: the modal must track the new
    // key instead of snapping shut on a now-missing old key.
    expect(nextSelectedKeyAfterSave("old@x.io", "old@x.io", "new@x.io")).toBe(
      "new@x.io",
    )
  })

  it("leaves an unrelated selection alone when a different row moves keys", () => {
    expect(nextSelectedKeyAfterSave("42", "old@x.io", "new@x.io")).toBe("42")
  })

  it("does nothing when nothing is selected", () => {
    expect(nextSelectedKeyAfterSave(null, "old@x.io", "new@x.io")).toBeNull()
  })

  it("ignores an empty new key (never selects nothing by accident)", () => {
    expect(nextSelectedKeyAfterSave("42", "42", "")).toBe("42")
  })
})
