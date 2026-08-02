import { describe, expect, it } from "vitest"
import {
  resolveClassroomRole,
  applyViewAs,
  roleLabelKey,
  type ClassroomRoleInput,
} from "@/authz"

// The pure resolution is exercised in depth in resolveRole.test.ts. This suite
// pins the KTD-4 behavior change directly against the pure resolver: org-admin
// status is not a classroom role, so an org owner on none of a classroom's
// teams resolves to `student` at classroom scope.
const base: ClassroomRoleInput = {
  org: "acme",
  classroom: "cs101",
  teacher: "non-member",
  hta: "non-member",
  ta: "non-member",
  student: "non-member",
}

describe("resolveClassroomRole (KTD-4: owner is not a classroom role)", () => {
  it("an org owner on no classroom team is a student at classroom scope", () => {
    expect(resolveClassroomRole(base)).toBe("student")
  })

  it("teacher-team membership resolves to teacher", () => {
    expect(resolveClassroomRole({ ...base, teacher: "member" })).toBe("teacher")
  })

  it("holds unresolved while an elevation read is in flight (fail-closed)", () => {
    expect(resolveClassroomRole({ ...base, teacher: "unresolved" })).toBe(
      "unresolved",
    )
  })
})

describe("role predicates stay wired", () => {
  it("roleLabelKey", () => {
    expect(roleLabelKey("teacher")).toBe("nav.roleTeacher")
    expect(roleLabelKey("unresolved")).toBeNull()
  })
  it("applyViewAs downgrade-only", () => {
    expect(applyViewAs("teacher", "student")).toBe("student")
    expect(applyViewAs("student", "ta")).toBe("student")
  })
})
