import { describe, expect, it } from "vitest"
import {
  resolveClassroomRole,
  isStaffRole,
  isInstructorRole,
  applyViewAs,
  roleLabelKey,
  type ClassroomRoleInput,
} from "./useClassroomRole"

const base: ClassroomRoleInput = {
  org: "acme",
  classroom: "cs101",
  isOwner: false,
  staffRoleResolved: true,
  isStaff: true,
  instructor: "non-member",
  ta: "non-member",
}

describe("resolveClassroomRole", () => {
  it("owner outranks everything and needs no staff/team read", () => {
    expect(
      resolveClassroomRole({
        ...base,
        isOwner: true,
        // even with unresolved staff/team signals, owner short-circuits
        staffRoleResolved: false,
        instructor: "unresolved",
        ta: "unresolved",
      }),
    ).toBe("owner")
  })

  it("instructor when in the instructor team", () => {
    expect(resolveClassroomRole({ ...base, instructor: "member" })).toBe(
      "instructor",
    )
  })

  it("instructor outranks ta when in both", () => {
    expect(
      resolveClassroomRole({ ...base, instructor: "member", ta: "member" }),
    ).toBe("instructor")
  })

  it("ta when in the ta team but not the instructor team", () => {
    expect(resolveClassroomRole({ ...base, ta: "member" })).toBe("ta")
  })

  it("student when staff (repo access) but in neither staff team", () => {
    expect(resolveClassroomRole(base)).toBe("student")
  })

  it("student when not staff (no config-repo access), ignoring stale team signal", () => {
    expect(
      resolveClassroomRole({
        ...base,
        isStaff: false,
        instructor: "member",
      }),
    ).toBe("student")
  })

  describe("fail-closed (unresolved) on transient signals we depend on", () => {
    it("unresolved when the staff (repo) verdict isn't resolved and not an owner", () => {
      expect(
        resolveClassroomRole({
          ...base,
          isOwner: undefined,
          staffRoleResolved: false,
        }),
      ).toBe("unresolved")
    })

    it("unresolved when staff but a team read is in flight", () => {
      expect(resolveClassroomRole({ ...base, instructor: "unresolved" })).toBe(
        "unresolved",
      )
      expect(resolveClassroomRole({ ...base, ta: "unresolved" })).toBe(
        "unresolved",
      )
    })

    it("does NOT go unresolved on a team read when a higher role already matched", () => {
      // instructor member resolves before the ta-unresolved is considered
      expect(
        resolveClassroomRole({
          ...base,
          instructor: "member",
          ta: "unresolved",
        }),
      ).toBe("instructor")
    })

    it("holds unresolved on a CLASSROOM route while ownership is still loading (don't flash a real owner as student)", () => {
      // isOwner undefined + no team match => hold rather than demote.
      expect(
        resolveClassroomRole({
          ...base,
          isOwner: undefined,
        }),
      ).toBe("unresolved")
    })

    it("still resolves a confirmed staff-team member while ownership loads (team read is definitive)", () => {
      expect(
        resolveClassroomRole({
          ...base,
          isOwner: undefined,
          instructor: "member",
        }),
      ).toBe("instructor")
      expect(
        resolveClassroomRole({
          ...base,
          isOwner: undefined,
          ta: "member",
        }),
      ).toBe("ta")
    })

    it("demotes to student on a classroom route only once ownership is known (isOwner false)", () => {
      // staff (repo access) but in neither team AND a definitive non-owner.
      expect(resolveClassroomRole({ ...base, isOwner: false })).toBe("student")
    })
  })

  describe("org/classroom-less contexts", () => {
    it("is student with no org", () => {
      expect(resolveClassroomRole({ ...base, org: undefined })).toBe("student")
    })
    it("resolves OWNER on an org-level route with no classroom (Create Classroom regression)", () => {
      expect(
        resolveClassroomRole({
          ...base,
          classroom: undefined,
          isOwner: true,
        }),
      ).toBe("owner")
    })
    it("holds unresolved on an org-level route while ownership is still loading", () => {
      expect(
        resolveClassroomRole({
          ...base,
          classroom: undefined,
          isOwner: undefined,
        }),
      ).toBe("unresolved")
    })
    it("is student on an org-level route for a known non-owner", () => {
      expect(
        resolveClassroomRole({
          ...base,
          classroom: undefined,
          isOwner: false,
        }),
      ).toBe("student")
    })
  })
})

describe("role predicates", () => {
  it("isStaffRole: owner/instructor/ta/unresolved true; student false", () => {
    expect(isStaffRole("owner")).toBe(true)
    expect(isStaffRole("instructor")).toBe(true)
    expect(isStaffRole("ta")).toBe(true)
    expect(isStaffRole("unresolved")).toBe(true) // permissive: let page load
    expect(isStaffRole("student")).toBe(false)
  })

  it("isInstructorRole: owner/instructor/unresolved true; ta/student false", () => {
    expect(isInstructorRole("owner")).toBe(true)
    expect(isInstructorRole("instructor")).toBe(true)
    expect(isInstructorRole("unresolved")).toBe(true)
    expect(isInstructorRole("ta")).toBe(false)
    expect(isInstructorRole("student")).toBe(false)
  })

  it("roleLabelKey: owner+instructor => nav.roleInstructor, ta => nav.roleTa, student => nav.roleStudent, unresolved => null", () => {
    expect(roleLabelKey("owner")).toBe("nav.roleInstructor")
    expect(roleLabelKey("instructor")).toBe("nav.roleInstructor")
    expect(roleLabelKey("ta")).toBe("nav.roleTa")
    expect(roleLabelKey("student")).toBe("nav.roleStudent")
    expect(roleLabelKey("unresolved")).toBeNull()
  })
})

describe("applyViewAs (#221 downgrade-only preview)", () => {
  it("passes through when no preview is set", () => {
    expect(applyViewAs("owner", null)).toBe("owner")
    expect(applyViewAs("ta", null)).toBe("ta")
  })

  it("lets an owner preview ta or student", () => {
    expect(applyViewAs("owner", "ta")).toBe("ta")
    expect(applyViewAs("owner", "student")).toBe("student")
  })

  it("lets an instructor preview ta or student", () => {
    expect(applyViewAs("instructor", "ta")).toBe("ta")
    expect(applyViewAs("instructor", "student")).toBe("student")
  })

  it("NEVER escalates: a real ta/student previewing higher stays put", () => {
    expect(applyViewAs("ta", "student")).toBe("student")
    expect(applyViewAs("student", "ta")).toBe("student")
    expect(applyViewAs("student", "student")).toBe("student")
  })

  it("never raises above the actual role (instructor previewing 'ta' can't exceed)", () => {
    expect(applyViewAs("instructor", "ta")).toBe("ta")
  })

  it("does not clamp an unresolved role (guard still resolving)", () => {
    expect(applyViewAs("unresolved", "student")).toBe("unresolved")
  })

  it("a preview equal to or above the actual role is a no-op", () => {
    expect(applyViewAs("ta", "ta")).toBe("ta")
  })
})
