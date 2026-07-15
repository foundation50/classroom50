import { describe, expect, it } from "vitest"
import { classroomTeamSlug, parseClassroomTeamSlug } from "./teamSlug"

// Byte-identity guard: these strings are a cross-tool contract (CLI + schema
// hand-mirror them). A change here that isn't mirrored breaks membership reads
// and template grants, so pin the exact wire form.
describe("classroomTeamSlug", () => {
  it("students team drops the role suffix", () => {
    expect(classroomTeamSlug("cs-principles")).toBe("classroom50-cs-principles")
    expect(classroomTeamSlug("cs101", "student")).toBe("classroom50-cs101")
  })

  it("staff roles append the role suffix", () => {
    expect(classroomTeamSlug("cs101", "instructor")).toBe(
      "classroom50-cs101-instructor",
    )
    expect(classroomTeamSlug("cs101", "ta")).toBe("classroom50-cs101-ta")
  })
})

describe("parseClassroomTeamSlug", () => {
  it("parses a staff slug back to { classroom, role }", () => {
    expect(parseClassroomTeamSlug("classroom50-cs101-instructor")).toEqual({
      classroom: "cs101",
      role: "instructor",
    })
    expect(parseClassroomTeamSlug("classroom50-cs101-ta")).toEqual({
      classroom: "cs101",
      role: "ta",
    })
  })

  it("round-trips classroomTeamSlug for a hyphenated classroom name", () => {
    // A classroom short-name may contain hyphens; the parser must match the role
    // SUFFIX, not split naively on '-'.
    const slug = classroomTeamSlug("cs-principles", "instructor")
    expect(slug).toBe("classroom50-cs-principles-instructor")
    expect(parseClassroomTeamSlug(slug)).toEqual({
      classroom: "cs-principles",
      role: "instructor",
    })
  })

  it("returns null for a student slug (no staff-role suffix)", () => {
    expect(parseClassroomTeamSlug("classroom50-cs101")).toBeNull()
  })

  it("returns null for a non-classroom slug", () => {
    expect(parseClassroomTeamSlug("some-other-team")).toBeNull()
    expect(parseClassroomTeamSlug("classroom50")).toBeNull()
  })

  it("returns null when there is no classroom segment before the role suffix", () => {
    // `classroom50-instructor` has an empty middle — not a real per-classroom
    // team, so it must not parse to a staff membership.
    expect(parseClassroomTeamSlug("classroom50-instructor")).toBeNull()
  })
})
