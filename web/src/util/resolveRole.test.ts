import { describe, expect, it } from "vitest"
import {
  resolveClassroomRole,
  resolveOrgRole,
  isStaffRole,
  isInstructorRole,
  applyViewAs,
  roleLabelKey,
  membershipFromQuery,
  resolveTeacherVerdict,
  applyViewAsToVerdict,
  type ClassroomRoleInput,
} from "./resolveRole"
import { GitHubAPIError } from "@/hooks/github/errors"

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
  staffRoleResolved: true,
  isStaff: true,
  instructor: "non-member",
  ta: "non-member",
}

describe("resolveClassroomRole", () => {
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
      resolveClassroomRole({ ...base, isStaff: false, instructor: "member" }),
    ).toBe("student")
  })

  // KTD-4: the key behavior change. An org owner not on THIS classroom's
  // instructor team resolves to `student` at classroom scope — org-admin status
  // is no longer a classroom short-circuit. Org capability lives in OrgRole.
  it("org owner NOT on the instructor team is a student at classroom scope (KTD-4)", () => {
    // No isOwner input exists anymore; a real owner reads the config repo as a
    // student (404) or is staff-but-teamless. Either way => student here.
    expect(resolveClassroomRole(base)).toBe("student")
    expect(
      resolveClassroomRole({
        ...base,
        isStaff: false,
        staffRoleResolved: true,
      }),
    ).toBe("student")
  })

  describe("fail-closed (unresolved) on transient signals we depend on", () => {
    it("unresolved when the staff (repo) verdict isn't resolved", () => {
      expect(resolveClassroomRole({ ...base, staffRoleResolved: false })).toBe(
        "unresolved",
      )
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
      expect(
        resolveClassroomRole({
          ...base,
          instructor: "member",
          ta: "unresolved",
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
    it(`member on a definitive ${status}`, () => {
      expect(
        resolveOrgRole({
          isSuccess: false,
          role: undefined,
          state: undefined,
          error: apiError(status),
        }),
      ).toBe("member")
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

  it("isInstructorRole: instructor/unresolved true; ta/student false", () => {
    expect(isInstructorRole("instructor")).toBe(true)
    expect(isInstructorRole("unresolved")).toBe(true)
    expect(isInstructorRole("ta")).toBe(false)
    expect(isInstructorRole("student")).toBe(false)
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

describe("resolveTeacherVerdict", () => {
  const success = (
    permissions: Record<string, boolean>,
    org: string | undefined = "acme",
  ) => resolveTeacherVerdict({ org, isSuccess: true, permissions, error: null })

  const failure = (error: unknown, org: string | undefined = "acme") =>
    resolveTeacherVerdict({
      org,
      isSuccess: false,
      permissions: undefined,
      error,
    })

  for (const perm of ["admin", "maintain", "push", "pull"]) {
    it(`treats ${perm} access as teacher`, () => {
      const v = success({ [perm]: true })
      expect(v.isTeacher).toBe(true)
      expect(v.showTeacherUi).toBe(true)
      expect(v.roleResolved).toBe(true)
      expect(v.isStudent).toBe(false)
      expect(v.isBlocked).toBe(false)
    })
  }

  it("classifies a 404 as a resolved student, never teacher", () => {
    const v = failure(apiError(404))
    expect(v.isStudent).toBe(true)
    expect(v.isTeacher).toBe(false)
    expect(v.showTeacherUi).toBe(false)
    expect(v.roleResolved).toBe(true)
  })

  it("classifies a 403 as a resolved blocked user, never teacher", () => {
    const v = failure(apiError(403))
    expect(v.isBlocked).toBe(true)
    expect(v.isTeacher).toBe(false)
    expect(v.roleResolved).toBe(true)
  })

  for (const status of [500, 502, 503, 429]) {
    it(`leaves the role UNRESOLVED on a ${status} (fail-closed)`, () => {
      const v = failure(apiError(status))
      expect(v.roleResolved).toBe(false)
      expect(v.showTeacherUi).toBe(false)
      expect(v.isStudent).toBe(false)
      expect(v.isBlocked).toBe(false)
    })
  }

  it("org-less route resolves immediately with no role and no teacher UI", () => {
    const v = resolveTeacherVerdict({
      org: undefined,
      isSuccess: false,
      permissions: undefined,
      error: null,
    })
    expect(v.roleResolved).toBe(true)
    expect(v.showTeacherUi).toBe(false)
  })
})

describe("applyViewAsToVerdict (downgrade-only preview)", () => {
  const teacher = resolveTeacherVerdict({
    org: "acme",
    isSuccess: true,
    permissions: { push: true },
    error: null,
  })
  const student = resolveTeacherVerdict({
    org: "acme",
    isSuccess: false,
    permissions: undefined,
    error: apiError(404),
  })

  it("a teacher previewing 'student' is downgraded", () => {
    const v = applyViewAsToVerdict(teacher, "student")
    expect(v.isTeacher).toBe(false)
    expect(v.isStudent).toBe(true)
    expect(v.showTeacherUi).toBe(false)
  })

  it("a teacher previewing 'ta' keeps teacher UI", () => {
    expect(applyViewAsToVerdict(teacher, "ta")).toEqual(teacher)
  })

  it("no preview is a no-op", () => {
    expect(applyViewAsToVerdict(teacher, null)).toEqual(teacher)
  })

  it("NEVER escalates: a real student previewing 'student' stays a student", () => {
    expect(applyViewAsToVerdict(student, "student")).toEqual(student)
  })
})
