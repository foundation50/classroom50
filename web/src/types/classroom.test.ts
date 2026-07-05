import { describe, expect, it } from "vitest"

import { isClassroomArchived } from "./classroom"

describe("isClassroomArchived", () => {
  it("treats an explicit active: false as archived", () => {
    expect(isClassroomArchived({ active: false })).toBe(true)
  })

  it("treats active: true as not archived", () => {
    expect(isClassroomArchived({ active: true })).toBe(false)
  })

  it("treats an absent active flag as not archived (legacy classrooms)", () => {
    // Legacy classroom.json never wrote `active`, so undefined must read as
    // active.
    expect(isClassroomArchived({})).toBe(false)
    expect(isClassroomArchived({ active: undefined })).toBe(false)
  })
})
