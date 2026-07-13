import { describe, expect, it } from "vitest"
import {
  resolveClassroomRole,
  isStaffRole,
  isInstructorRole,
  applyViewAs,
  roleLabelKey,
  type ClassroomRoleInput,
} from "@/util/resolveRole"

// The pure resolution is exercised in depth in resolveRole.test.ts. This suite
// pins the KTD-4 behavior change directly against the pure resolver: org-admin
// status is no longer a classroom short-circuit, so an org owner not on a
// classroom's instructor team resolves to `student` at classroom scope.
const base: ClassroomRoleInput = {
  org: "acme",
  classroom: "cs101",
  staffRoleResolved: true,
  isStaff: true,
  instructor: "non-member",
  ta: "non-member",
}

describe("resolveClassroomRole (KTD-4: owner is not a classroom role)", () => {
  it("an org owner not on the instructor team is a student at classroom scope", () => {
    // Previously this case short-circuited to "owner"; now, without a team
    // membership, staff-but-teamless resolves to student.
    expect(resolveClassroomRole(base)).toBe("student")
  })

  it("instructor-team membership resolves to instructor", () => {
    expect(resolveClassroomRole({ ...base, instructor: "member" })).toBe(
      "instructor",
    )
  })

  it("holds unresolved while the staff verdict is in flight (fail-closed)", () => {
    expect(resolveClassroomRole({ ...base, staffRoleResolved: false })).toBe(
      "unresolved",
    )
  })
})

describe("re-exported role predicates stay wired", () => {
  it("isStaffRole / isInstructorRole", () => {
    expect(isStaffRole("ta")).toBe(true)
    expect(isInstructorRole("ta")).toBe(false)
    expect(isInstructorRole("instructor")).toBe(true)
  })
  it("roleLabelKey", () => {
    expect(roleLabelKey("instructor")).toBe("nav.roleInstructor")
    expect(roleLabelKey("unresolved")).toBeNull()
  })
  it("applyViewAs downgrade-only", () => {
    expect(applyViewAs("instructor", "student")).toBe("student")
    expect(applyViewAs("student", "ta")).toBe("student")
  })
})
