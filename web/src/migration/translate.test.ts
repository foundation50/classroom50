// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts down.
import { describe, expect, it } from "vitest"

import type { ClassroomAssignmentDetail, ClassroomDetail } from "./types"
import {
  assignmentToEntry,
  classroomMigratedFrom,
  deriveShortName,
  migratedDueFields,
} from "./translate"

const AT = new Date("2026-07-29T10:00:00Z")

const detail = (
  over: Partial<ClassroomAssignmentDetail> = {},
): ClassroomAssignmentDetail => ({
  id: 1,
  public_repo: true,
  title: "Homework One",
  type: "individual",
  invite_link: "https://classroom.github.com/a/abc",
  slug: "hw1",
  deadline: null,
  max_teams: null,
  starter_code_repository: {
    id: 9,
    name: "hw1",
    full_name: "src-org/hw1",
    private: true,
    default_branch: "main",
  },
  ...over,
})

const target = { owner: "dst", repo: "hw1", branch: "main" }

describe("deriveShortName", () => {
  it("slugifies a free-form name", () => {
    expect(deriveShortName("CS 50: Intro!")).toBe("cs-50-intro")
  })

  it("throws on an empty name", () => {
    expect(() => deriveShortName("   ")).toThrow(/empty/i)
  })

  it("rejects a name that slugifies to a non-canonical team short-name", () => {
    // Leading punctuation collapses so this is fine; use a value that would
    // trail a hyphen after truncation to hit the canonical guard indirectly —
    // here a single char is below the 2-char minimum instead.
    expect(() => deriveShortName("A")).toThrow(/valid short name/i)
  })
})

describe("migratedDueFields", () => {
  it("keeps an offset-bearing deadline, normalized to UTC, source migrated", () => {
    const res = migratedDueFields("2026-05-01T23:59:00-04:00")
    expect(res).not.toBeNull()
    expect(res!.due).toBe("2026-05-02T03:59:00Z")
    expect(res!.due_meta.source).toBe("migrated")
    expect(res!.due_meta.offset).toBe("-04:00")
  })

  it("keeps a Z-suffixed deadline", () => {
    const res = migratedDueFields("2026-05-01T23:59:00Z")
    expect(res!.due).toBe("2026-05-01T23:59:00Z")
    expect(res!.due_meta.offset).toBe("+00:00")
  })

  it("drops a zone-less deadline", () => {
    expect(migratedDueFields("2026-05-01T23:59:00")).toBeNull()
  })

  it("drops null", () => {
    expect(migratedDueFields(null)).toBeNull()
  })
})

describe("assignmentToEntry", () => {
  it("maps an individual assignment with migrated_from", () => {
    const entry = assignmentToEntry(detail(), 42, target, AT)
    expect(entry).toMatchObject({
      slug: "hw1",
      name: "Homework One",
      mode: "individual",
      autograder: "default",
      template: target,
    })
    expect(entry.migrated_from).toMatchObject({
      source: "github_classroom",
      classroom_id: 42,
      assignment_id: 1,
      starter_repo: "src-org/hw1",
      invite_link: "https://classroom.github.com/a/abc",
    })
    expect(entry.max_group_size).toBeUndefined()
  })

  it("keeps a valid group max_teams", () => {
    const entry = assignmentToEntry(
      detail({ type: "group", max_teams: 4 }),
      1,
      target,
      AT,
    )
    expect(entry.max_group_size).toBe(4)
  })

  it("falls back to the cap for a missing/odd group size", () => {
    const entry = assignmentToEntry(
      detail({ type: "group", max_teams: null }),
      1,
      target,
      AT,
    )
    expect(entry.max_group_size).toBe(100)
  })

  it("records an offset-bearing deadline", () => {
    const entry = assignmentToEntry(
      detail({ deadline: "2026-05-01T23:59:00Z" }),
      1,
      target,
      AT,
    )
    expect(entry.due).toBe("2026-05-01T23:59:00Z")
    expect(entry.due_meta?.source).toBe("migrated")
  })

  it("throws on an unknown type", () => {
    expect(() =>
      assignmentToEntry(detail({ type: "weird" }), 1, target, AT),
    ).toThrow(/unknown type/i)
  })

  it("throws on an invalid slug", () => {
    expect(() =>
      assignmentToEntry(detail({ slug: "Bad Slug" }), 1, target, AT),
    ).toThrow(/invalid/i)
  })
})

describe("classroomMigratedFrom", () => {
  it("builds the classroom-level provenance block", () => {
    const cd: ClassroomDetail = {
      id: 7,
      name: "CS50",
      archived: false,
      url: "https://classroom.github.com/classrooms/7",
      organization: { id: 1, login: "src-org" },
    }
    expect(classroomMigratedFrom(cd, AT)).toEqual({
      source: "github_classroom",
      classroom_id: 7,
      original_name: "CS50",
      original_org_login: "src-org",
      url: "https://classroom.github.com/classrooms/7",
      migrated_at: "2026-07-29T10:00:00Z",
    })
  })
})
