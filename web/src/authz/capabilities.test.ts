import { describe, expect, it } from "vitest"
import { can, type Capability, type CapabilityInput } from "./capabilities"
import type { ResolvedRole, GitHubOrgRole } from "./resolveRole"

// Table-driven parity: the policy must exactly mirror the role semantics the
// scattered role-literal checks used to encode. Includes the KTD-4 rule (org
// owner is NOT a classroom instructor) and the deny-by-default posture.

const orgRoles: GitHubOrgRole[] = [
  "owner",
  "member",
  "non-member",
  "unresolved",
]
const classroomRoles: ResolvedRole[] = [
  "instructor",
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
  it("viewClassroomStaffContent: instructor|ta; unresolved and student denied", () => {
    expect(
      can("viewClassroomStaffContent", { classroomRole: "instructor" }),
    ).toBe(true)
    expect(can("viewClassroomStaffContent", { classroomRole: "ta" })).toBe(true)
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

  it("editClassroomSettings: instructor only (TA, student, unresolved all denied)", () => {
    expect(can("editClassroomSettings", { classroomRole: "instructor" })).toBe(
      true,
    )
    expect(can("editClassroomSettings", { classroomRole: "unresolved" })).toBe(
      false,
    )
    expect(can("editClassroomSettings", { classroomRole: "ta" })).toBe(false)
    expect(can("editClassroomSettings", { classroomRole: "student" })).toBe(
      false,
    )
    expect(can("editClassroomSettings", {})).toBe(false)
  })

  it("previewAsRole: a real instructor only (never TA/student/unresolved)", () => {
    expect(can("previewAsRole", { classroomRole: "instructor" })).toBe(true)
    expect(can("previewAsRole", { classroomRole: "ta" })).toBe(false)
    expect(can("previewAsRole", { classroomRole: "student" })).toBe(false)
    expect(can("previewAsRole", { classroomRole: "unresolved" })).toBe(false)
  })
})

describe("can — claimInstructor (KTD-4 self-repair)", () => {
  it("only an org owner who currently resolves to student in the classroom", () => {
    expect(
      can("claimInstructor", {
        githubOrgRole: "owner",
        classroomRole: "student",
      }),
    ).toBe(true)
  })

  it("KTD-4: an org owner is NOT auto-instructor — but an owner already on the instructor team never sees the affordance", () => {
    expect(
      can("claimInstructor", {
        githubOrgRole: "owner",
        classroomRole: "instructor",
      }),
    ).toBe(false)
    expect(
      can("claimInstructor", { githubOrgRole: "owner", classroomRole: "ta" }),
    ).toBe(false)
  })

  it("never offered to a non-owner or mid-resolution", () => {
    expect(
      can("claimInstructor", {
        githubOrgRole: "member",
        classroomRole: "student",
      }),
    ).toBe(false)
    expect(
      can("claimInstructor", {
        githubOrgRole: "non-member",
        classroomRole: "student",
      }),
    ).toBe(false)
    expect(
      can("claimInstructor", {
        githubOrgRole: "owner",
        classroomRole: "unresolved",
      }),
    ).toBe(false)
    expect(
      can("claimInstructor", {
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
    "editClassroomSettings",
    "previewAsRole",
    "claimInstructor",
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
