import { describe, expect, it } from "vitest"
import { can, type Capability, type CapabilityInput } from "./capabilities"
import type { ResolvedRole, GitHubOrgRole } from "./resolveRole"

// Table-driven parity: the policy must exactly mirror the role semantics the
// scattered role-literal checks used to encode. Includes the KTD-4 rule (org
// owner is NOT a classroom teacher) and the deny-by-default posture.

const orgRoles: GitHubOrgRole[] = [
  "owner",
  "member",
  "non-member",
  "unresolved",
]
const classroomRoles: ResolvedRole[] = [
  "teacher",
  "instructor",
  "hta",
  "ta",
  "student",
  "unresolved",
]

describe("can — org capabilities", () => {
  it("manageOrg: only an org owner", () => {
    expect(can("manageOrg", { githubOrgRole: "owner" })).toBe(true)
    expect(can("manageOrg", { githubOrgRole: "member" })).toBe(false)
    expect(can("manageOrg", { githubOrgRole: "non-member" })).toBe(false)
    expect(can("manageOrg", { githubOrgRole: "unresolved" })).toBe(false)
    // Classroom role is irrelevant to org capabilities.
    for (const classroomRole of classroomRoles) {
      expect(can("manageOrg", { githubOrgRole: "member", classroomRole })).toBe(
        false,
      )
    }
  })

  it("viewOrgStaffContent: keyed on the org-scoped team-based staff signal", () => {
    expect(can("viewOrgStaffContent", { orgStaff: true })).toBe(true)
    expect(can("viewOrgStaffContent", { orgStaff: false })).toBe(false)
    expect(can("viewOrgStaffContent", {})).toBe(false)
  })
})

describe("can — classroom capabilities (fail-closed on unresolved)", () => {
  it("viewClassroomStaffContent: teacher|ta; unresolved and student denied", () => {
    expect(can("viewClassroomStaffContent", { classroomRole: "teacher" })).toBe(
      true,
    )
    // Legacy instructor alias still resolves to staff.
    expect(
      can("viewClassroomStaffContent", { classroomRole: "instructor" }),
    ).toBe(true)
    expect(can("viewClassroomStaffContent", { classroomRole: "ta" })).toBe(true)
    // Head TA sees staff content (R6).
    expect(can("viewClassroomStaffContent", { classroomRole: "hta" })).toBe(
      true,
    )
    // Fail-closed: an unresolved role is denied by the policy itself; the
    // caller's separate `resolved` gate holds a spinner rather than NotFound.
    expect(
      can("viewClassroomStaffContent", { classroomRole: "unresolved" }),
    ).toBe(false)
    expect(can("viewClassroomStaffContent", { classroomRole: "student" })).toBe(
      false,
    )
    // Off a classroom (no classroomRole) — denied.
    expect(can("viewClassroomStaffContent", {})).toBe(false)
  })

  it("authorAssignments: teacher|hta only (TA read-only, student/unresolved denied)", () => {
    expect(can("authorAssignments", { classroomRole: "teacher" })).toBe(true)
    expect(can("authorAssignments", { classroomRole: "instructor" })).toBe(true)
    expect(can("authorAssignments", { classroomRole: "hta" })).toBe(true)
    expect(can("authorAssignments", { classroomRole: "ta" })).toBe(false)
    expect(can("authorAssignments", { classroomRole: "student" })).toBe(false)
    // Fail-closed on the in-flight sentinel.
    expect(can("authorAssignments", { classroomRole: "unresolved" })).toBe(
      false,
    )
    // Off a classroom (no classroomRole) — denied.
    expect(can("authorAssignments", {})).toBe(false)
  })

  it("editClassroomSettings: teacher only (TA, student, unresolved all denied)", () => {
    expect(can("editClassroomSettings", { classroomRole: "teacher" })).toBe(
      true,
    )
    expect(can("editClassroomSettings", { classroomRole: "instructor" })).toBe(
      true,
    )
    expect(can("editClassroomSettings", { classroomRole: "unresolved" })).toBe(
      false,
    )
    expect(can("editClassroomSettings", { classroomRole: "ta" })).toBe(false)
    // Head TA cannot see Settings — teacher-only (R7).
    expect(can("editClassroomSettings", { classroomRole: "hta" })).toBe(false)
    expect(can("editClassroomSettings", { classroomRole: "student" })).toBe(
      false,
    )
    expect(can("editClassroomSettings", {})).toBe(false)
  })

  it("previewAsRole: a real teacher only (never TA/student/unresolved)", () => {
    expect(can("previewAsRole", { classroomRole: "teacher" })).toBe(true)
    expect(can("previewAsRole", { classroomRole: "instructor" })).toBe(true)
    expect(can("previewAsRole", { classroomRole: "ta" })).toBe(false)
    expect(can("previewAsRole", { classroomRole: "hta" })).toBe(false)
    expect(can("previewAsRole", { classroomRole: "student" })).toBe(false)
    expect(can("previewAsRole", { classroomRole: "unresolved" })).toBe(false)
  })
})

describe("can — claimTeacher (KTD-4 self-repair)", () => {
  it("only an org owner who currently resolves to student in the classroom", () => {
    expect(
      can("claimTeacher", {
        githubOrgRole: "owner",
        classroomRole: "student",
      }),
    ).toBe(true)
  })

  it("KTD-4: an org owner is NOT auto-teacher — but an owner already on the teacher team never sees the affordance", () => {
    expect(
      can("claimTeacher", {
        githubOrgRole: "owner",
        classroomRole: "teacher",
      }),
    ).toBe(false)
    expect(
      can("claimTeacher", {
        githubOrgRole: "owner",
        classroomRole: "instructor",
      }),
    ).toBe(false)
    expect(
      can("claimTeacher", { githubOrgRole: "owner", classroomRole: "ta" }),
    ).toBe(false)
  })

  it("never offered to a non-owner or mid-resolution", () => {
    expect(
      can("claimTeacher", {
        githubOrgRole: "member",
        classroomRole: "student",
      }),
    ).toBe(false)
    expect(
      can("claimTeacher", {
        githubOrgRole: "non-member",
        classroomRole: "student",
      }),
    ).toBe(false)
    expect(
      can("claimTeacher", {
        githubOrgRole: "owner",
        classroomRole: "unresolved",
      }),
    ).toBe(false)
    expect(
      can("claimTeacher", {
        githubOrgRole: "unresolved",
        classroomRole: "student",
      }),
    ).toBe(false)
  })
})

describe("deny-by-default coverage across the whole matrix", () => {
  const caps: Capability[] = [
    "manageOrg",
    "viewOrgStaffContent",
    "viewClassroomStaffContent",
    "authorAssignments",
    "editClassroomSettings",
    "previewAsRole",
    "claimTeacher",
  ]

  it("every capability returns a boolean for every role combination", () => {
    for (const cap of caps) {
      for (const orgRole of orgRoles) {
        for (const classroomRole of classroomRoles) {
          const input: CapabilityInput = {
            githubOrgRole: orgRole,
            classroomRole,
          }
          expect(typeof can(cap, input)).toBe("boolean")
        }
      }
    }
  })
})
