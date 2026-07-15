import { describe, expect, it } from "vitest"
import {
  resolveClassroomRole,
  resolveOrgRole,
  resolveOrgStaff,
  isStaffRole,
  applyViewAs,
  roleLabelKey,
  membershipFromQuery,
  type ClassroomRoleInput,
} from "./resolveRole"
import { GitHubAPIError } from "@/github-core/errors"

const apiError = (status: number) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/repos/acme/classroom50",
    message: `boom ${status}`,
    body: null,
    rateLimit: {
      limit: null,
      remaining: null,
      used: null,
      reset: null,
      resource: null,
      retryAfter: null,
    },
  })

const base: ClassroomRoleInput = {
  org: "acme",
  classroom: "cs101",
  instructor: "non-member",
  ta: "non-member",
  student: "non-member",
}

describe("resolveClassroomRole", () => {
  it("instructor when in the instructor team", () => {
    expect(resolveClassroomRole({ ...base, instructor: "member" })).toBe(
      "instructor",
    )
  })

  it("instructor outranks ta and student when in several", () => {
    expect(
      resolveClassroomRole({
        ...base,
        instructor: "member",
        ta: "member",
        student: "member",
      }),
    ).toBe("instructor")
  })

  it("ta when in the ta team but not the instructor team", () => {
    expect(resolveClassroomRole({ ...base, ta: "member" })).toBe("ta")
  })

  it("student when on the students team only (positive student signal)", () => {
    expect(resolveClassroomRole({ ...base, student: "member" })).toBe("student")
  })

  it("student when a definitive non-member of all three teams", () => {
    expect(resolveClassroomRole(base)).toBe("student")
  })

  // KTD-4: the key behavior change. An org owner not on THIS classroom's teams
  // resolves to `student` at classroom scope — org-admin status is not a
  // classroom role. Org capability lives in OrgRole.
  it("org owner NOT on any classroom team is a student at classroom scope (KTD-4)", () => {
    // A real owner reads all three team memberships as definitive non-member.
    expect(resolveClassroomRole(base)).toBe("student")
  })

  describe("fail-closed (unresolved) on transient ELEVATION signals we depend on", () => {
    it("unresolved when an elevation read (instructor/ta) is in flight", () => {
      expect(resolveClassroomRole({ ...base, instructor: "unresolved" })).toBe(
        "unresolved",
      )
      expect(resolveClassroomRole({ ...base, ta: "unresolved" })).toBe(
        "unresolved",
      )
    })

    it("does NOT hold on an in-flight/errored STUDENTS read — falls through to student (never strand a real student)", () => {
      // The students team can't grant access, so its read is fail-open-to-
      // student once instructor/ta are definitive non-member.
      expect(resolveClassroomRole({ ...base, student: "unresolved" })).toBe(
        "student",
      )
    })

    it("does NOT go unresolved on a lower team read when a higher role already matched", () => {
      expect(
        resolveClassroomRole({
          ...base,
          instructor: "member",
          ta: "unresolved",
          student: "unresolved",
        }),
      ).toBe("instructor")
    })
  })

  describe("org/classroom-less contexts", () => {
    it("is student with no org", () => {
      expect(resolveClassroomRole({ ...base, org: undefined })).toBe("student")
    })
    it("is student with no classroom (org-level route has no classroom role)", () => {
      expect(resolveClassroomRole({ ...base, classroom: undefined })).toBe(
        "student",
      )
    })
  })
})

describe("resolveOrgRole", () => {
  it("owner when an active admin", () => {
    expect(
      resolveOrgRole({
        isSuccess: true,
        role: "admin",
        state: "active",
        error: null,
      }),
    ).toBe("owner")
  })

  it("member on a definitive non-admin success", () => {
    expect(
      resolveOrgRole({
        isSuccess: true,
        role: "member",
        state: "active",
        error: null,
      }),
    ).toBe("member")
  })

  for (const status of [403, 404]) {
    it(`non-member on a definitive ${status}`, () => {
      expect(
        resolveOrgRole({
          isSuccess: false,
          role: undefined,
          state: undefined,
          error: apiError(status),
        }),
      ).toBe("non-member")
    })
  }

  for (const status of [500, 502, 429]) {
    it(`unresolved on a transient ${status} (fail-closed)`, () => {
      expect(
        resolveOrgRole({
          isSuccess: false,
          role: undefined,
          state: undefined,
          error: apiError(status),
        }),
      ).toBe("unresolved")
    })
  }

  it("unresolved while loading (no answer yet)", () => {
    expect(
      resolveOrgRole({
        isSuccess: false,
        role: undefined,
        state: undefined,
        error: null,
      }),
    ).toBe("unresolved")
  })

  it("unresolved on a network (non-API) error", () => {
    expect(
      resolveOrgRole({
        isSuccess: false,
        role: undefined,
        state: undefined,
        error: new Error("network down"),
      }),
    ).toBe("unresolved")
  })
})

describe("membershipFromQuery", () => {
  it("member on success", () => {
    expect(membershipFromQuery(true, null)).toBe("member")
  })
  it("non-member on a definitive 404", () => {
    expect(membershipFromQuery(false, apiError(404))).toBe("non-member")
  })
  it("unresolved on a transient error (never demote)", () => {
    expect(membershipFromQuery(false, apiError(500))).toBe("unresolved")
    expect(membershipFromQuery(false, null)).toBe("unresolved")
  })
})

describe("role predicates", () => {
  it("isStaffRole: instructor/ta/unresolved true; student false", () => {
    expect(isStaffRole("instructor")).toBe(true)
    expect(isStaffRole("ta")).toBe(true)
    expect(isStaffRole("unresolved")).toBe(true) // permissive: let page load
    expect(isStaffRole("student")).toBe(false)
  })

  it("roleLabelKey: instructor => nav.roleInstructor, ta => nav.roleTa, student => nav.roleStudent, unresolved => null", () => {
    expect(roleLabelKey("instructor")).toBe("nav.roleInstructor")
    expect(roleLabelKey("ta")).toBe("nav.roleTa")
    expect(roleLabelKey("student")).toBe("nav.roleStudent")
    expect(roleLabelKey("unresolved")).toBeNull()
  })
})

describe("applyViewAs (downgrade-only preview)", () => {
  it("passes through when no preview is set", () => {
    expect(applyViewAs("instructor", null)).toBe("instructor")
    expect(applyViewAs("ta", null)).toBe("ta")
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

  it("does not clamp an unresolved role (guard still resolving)", () => {
    expect(applyViewAs("unresolved", "student")).toBe("unresolved")
  })

  it("a preview equal to or above the actual role is a no-op", () => {
    expect(applyViewAs("ta", "ta")).toBe("ta")
  })
})

describe("resolveOrgStaff", () => {
  it("staff when at least one classroom staff-team probe confirms membership", () => {
    const v = resolveOrgStaff(["non-member", "member", "non-member"], true)
    expect(v).toEqual({ isStaff: true, isNonStaff: false, roleResolved: true })
  })

  it("a confirmed membership wins even while a sibling probe is still in flight", () => {
    // A real staffer must never be held on a slow sibling read.
    const v = resolveOrgStaff(["member", "unresolved"], false)
    expect(v.isStaff).toBe(true)
    expect(v.roleResolved).toBe(true)
  })

  it("non-staff only when the class list settled AND every probe is definitively non-member", () => {
    const v = resolveOrgStaff(["non-member", "non-member"], true)
    expect(v).toEqual({ isStaff: false, isNonStaff: true, roleResolved: true })
  })

  it("empty org (no classrooms) with a settled class list is definitively non-staff", () => {
    // An org owner on no staff team (and no classrooms) is NOT org-staff — the
    // deliberate behavior change. They recover via ClaimInstructor / owner UI.
    const v = resolveOrgStaff([], true)
    expect(v).toEqual({ isStaff: false, isNonStaff: true, roleResolved: true })
  })

  it("holds unresolved while the classroom list is still loading (no flash of non-staff)", () => {
    expect(resolveOrgStaff([], false)).toEqual({
      isStaff: false,
      isNonStaff: false,
      roleResolved: false,
    })
    // Even with all-definitive probes, an unsettled class list holds.
    expect(resolveOrgStaff(["non-member"], false).roleResolved).toBe(false)
  })

  it("holds unresolved on a transient probe error (fail-closed — never demote)", () => {
    // A 5xx/429/network blip on a staff-team probe reduces to `unresolved`; the
    // viewer might be a real staffer, so hold rather than render non-staff.
    const v = resolveOrgStaff(["non-member", "unresolved"], true)
    expect(v).toEqual({
      isStaff: false,
      isNonStaff: false,
      roleResolved: false,
    })
  })
})
