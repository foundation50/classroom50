import { describe, expect, it } from "vitest"
import {
  classroomTeamSlug,
  classroomTeamSlugs,
  resolveClassroomRoleSlug,
  parseClassroomTeamSlug,
  parseStudentClassroomSlug,
  parseBareClassroomSlug,
} from "./teamSlug"

// Byte-identity guard: these strings are a cross-tool contract (CLI + schema
// hand-mirror them). A change here that isn't mirrored breaks membership reads
// and template grants, so pin the exact wire form.
describe("classroomTeamSlug", () => {
  it("students team drops the role suffix", () => {
    expect(classroomTeamSlug("cs-principles")).toBe("classroom50-cs-principles")
    expect(classroomTeamSlug("cs101", "student")).toBe("classroom50-cs101")
  })

  it("staff roles append the role suffix", () => {
    expect(classroomTeamSlug("cs101", "hta")).toBe("classroom50-cs101-hta")
    expect(classroomTeamSlug("cs101", "ta")).toBe("classroom50-cs101-ta")
  })
})

// The enrolled-set enumeration, student-first. Byte-mirrors
// the CLI's contract.ClassroomTeamSlugs — a drift here would let the accept
// gate and the CLI disagree on who counts as enrolled.
describe("classroomTeamSlugs", () => {
  it("returns the student team then every staff team", () => {
    expect(classroomTeamSlugs("cs-principles")).toEqual([
      "classroom50-cs-principles",
      "classroom50-cs-principles-teacher",
      "classroom50-cs-principles-hta",
      "classroom50-cs-principles-ta",
    ])
  })
})

describe("parseClassroomTeamSlug", () => {
  it("parses a staff slug back to { classroom, role }", () => {
    expect(parseClassroomTeamSlug("classroom50-cs101-hta")).toEqual({
      classroom: "cs101",
      role: "hta",
    })
    expect(parseClassroomTeamSlug("classroom50-cs101-ta")).toEqual({
      classroom: "cs101",
      role: "ta",
    })
  })

  it("round-trips classroomTeamSlug for a hyphenated classroom name", () => {
    // A classroom short-name may contain hyphens; the parser must match the role
    // SUFFIX, not split naively on '-'.
    const slug = classroomTeamSlug("cs-principles", "hta")
    expect(slug).toBe("classroom50-cs-principles-hta")
    expect(parseClassroomTeamSlug(slug)).toEqual({
      classroom: "cs-principles",
      role: "hta",
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
    // `classroom50-hta` has an empty middle — not a real per-classroom
    // team, so it must not parse to a staff membership.
    expect(parseClassroomTeamSlug("classroom50-hta")).toBeNull()
  })
})

describe("parseStudentClassroomSlug", () => {
  it("parses a bare student slug to its classroom", () => {
    expect(parseStudentClassroomSlug("classroom50-cs101")).toEqual({
      classroom: "cs101",
    })
  })

  it("round-trips the student classroomTeamSlug for a hyphenated name", () => {
    const slug = classroomTeamSlug("cs-principles", "student")
    expect(slug).toBe("classroom50-cs-principles")
    expect(parseStudentClassroomSlug(slug)).toEqual({
      classroom: "cs-principles",
    })
  })

  it("returns null for a staff slug (complement of parseClassroomTeamSlug)", () => {
    expect(parseStudentClassroomSlug("classroom50-cs101-ta")).toBeNull()
    expect(parseStudentClassroomSlug("classroom50-cs101-teacher")).toBeNull()
    expect(parseStudentClassroomSlug("classroom50-cs101-hta")).toBeNull()
  })

  it("returns null for a non-classroom slug", () => {
    expect(parseStudentClassroomSlug("some-other-team")).toBeNull()
    expect(parseStudentClassroomSlug("classroom50")).toBeNull()
  })

  it("does not mistake a hyphenated classroom ending in a role-like word", () => {
    // `classroom50-ml-ta` is ambiguous with a `-ta` staff suffix; the staff
    // parser owns it, so the student parser must yield null (safe-degrade: a
    // real ml-ta student team collision would 404 the membership read).
    expect(parseStudentClassroomSlug("classroom50-ml-ta")).toBeNull()
  })
})

describe("parseBareClassroomSlug", () => {
  it("returns the whole post-prefix segment, ignoring role suffixes", () => {
    expect(parseBareClassroomSlug("classroom50-cs101")).toEqual({
      classroom: "cs101",
    })
    // Unlike parseStudentClassroomSlug, it does NOT exclude a role-suffixed slug
    // — this is the whole point: `classroom50-ml-ta` -> `ml-ta`, so the caller
    // (gated on a bootstrap record) can recover the role-suffixed student
    // classroom the staff parser would otherwise claim as `ml`.
    expect(parseBareClassroomSlug("classroom50-ml-ta")).toEqual({
      classroom: "ml-ta",
    })
  })

  it("returns null for a non-classroom slug or empty segment", () => {
    expect(parseBareClassroomSlug("some-other-team")).toBeNull()
    expect(parseBareClassroomSlug("classroom50")).toBeNull()
    expect(parseBareClassroomSlug("classroom50-")).toBeNull()
  })
})

describe("resolveClassroomRoleSlug", () => {
  const ref = (slug: string) => ({ id: 1, slug })

  it("student prefers classroom.json team.slug, else derives", () => {
    expect(
      resolveClassroomRoleSlug("cs101", "student", {
        team: ref("gh-rewrote-student"),
      }),
    ).toBe("gh-rewrote-student")
    expect(resolveClassroomRoleSlug("cs101", "student", {})).toBe(
      "classroom50-cs101",
    )
  })

  it("teacher prefers teams.teacher, else derives", () => {
    expect(
      resolveClassroomRoleSlug("cs101", "teacher", {
        teams: { teacher: ref("gh-teacher") },
      }),
    ).toBe("gh-teacher")
    expect(resolveClassroomRoleSlug("cs101", "teacher", {})).toBe(
      "classroom50-cs101-teacher",
    )
  })

  it("generic staff roles prefer teams.<role>.slug, else derive", () => {
    expect(
      resolveClassroomRoleSlug("cs101", "ta", {
        teams: { ta: ref("gh-ta") },
      }),
    ).toBe("gh-ta")
    expect(
      resolveClassroomRoleSlug("cs101", "hta", {
        teams: { hta: ref("gh-hta") },
      }),
    ).toBe("gh-hta")
    expect(resolveClassroomRoleSlug("cs101", "ta", {})).toBe(
      "classroom50-cs101-ta",
    )
    expect(resolveClassroomRoleSlug("cs101", "hta", {})).toBe(
      "classroom50-cs101-hta",
    )
  })

  it("falls back to the derived slug for every role when refs is undefined", () => {
    expect(resolveClassroomRoleSlug("cs101", "student", undefined)).toBe(
      "classroom50-cs101",
    )
    expect(resolveClassroomRoleSlug("cs101", "teacher", undefined)).toBe(
      "classroom50-cs101-teacher",
    )
    expect(resolveClassroomRoleSlug("cs101", "ta", undefined)).toBe(
      "classroom50-cs101-ta",
    )
  })
})
