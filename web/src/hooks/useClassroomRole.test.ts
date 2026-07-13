import { describe, expect, it } from "vitest"
import {
  resolveClassroomRole,
  isStaffRole,
  applyViewAs,
  roleLabelKey,
  type ClassroomRoleInput,
} from "@/util/resolveRole"

// The pure resolution is exercised in depth in resolveRole.test.ts. This suite
// pins the KTD-4 behavior change directly against the pure resolver: org-admin
// status is not a classroom role, so an org owner on none of a classroom's
// teams resolves to `student` at classroom scope.
const base: ClassroomRoleInput = {
  org: "acme",
  classroom: "cs101",
  instructor: "non-member",
  ta: "non-member",
  student: "non-member",
}

describe("resolveClassroomRole (KTD-4: owner is not a classroom role)", () => {
  it("an org owner on no classroom team is a student at classroom scope", () => {
    expect(resolveClassroomRole(base)).toBe("student")
  })

  it("instructor-team membership resolves to instructor", () => {
    expect(resolveClassroomRole({ ...base, instructor: "member" })).toBe(
      "instructor",
    )
  })

  it("holds unresolved while an elevation read is in flight (fail-closed)", () => {
    expect(resolveClassroomRole({ ...base, instructor: "unresolved" })).toBe(
      "unresolved",
    )
  })
})

describe("role predicates stay wired", () => {
  it("isStaffRole", () => {
    expect(isStaffRole("ta")).toBe(true)
    expect(isStaffRole("instructor")).toBe(true)
    expect(isStaffRole("student")).toBe(false)
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
