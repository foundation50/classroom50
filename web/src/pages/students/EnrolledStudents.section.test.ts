import { describe, expect, it } from "vitest"
import {
  groupStudentsBySection,
  nextSelectedKeyAfterSave,
} from "./enrolledStudentsHelpers"
import type { Student } from "@/types/classroom"

const student = (username: string, section?: string): Student =>
  ({ username, section }) as Student

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
