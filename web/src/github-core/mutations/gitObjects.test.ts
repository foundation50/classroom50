import { describe, expect, it } from "vitest"
import { createClassroomMetadata } from "./gitObjects"
import type { StaffTeamRefs } from "./teams"

// Pins the classroom.json `teams` persistence gate in createClassroomMetadata.
// The instructor->teacher rename once left this gate reading only
// (teams.instructor || teams.ta), which silently dropped the teams block for a
// teacher-only classroom on create. These assert every staff-role-only block is
// persisted (and that an empty/absent block is still omitted, matching the
// CLI's `omitempty`).
describe("createClassroomMetadata teams persistence", () => {
  const teacher = { id: 1, slug: "classroom50-cs-teacher" }
  const ta = { id: 2, slug: "classroom50-cs-ta" }
  const instructor = { id: 3, slug: "classroom50-cs-instructor" }

  const build = (teams?: StaffTeamRefs) =>
    createClassroomMetadata(
      "org",
      "cs",
      undefined,
      "fall",
      undefined,
      undefined,
      teams,
    )

  it("persists a teacher-only teams block (the rename regression)", () => {
    const meta = build({ teacher })
    expect(meta.teams).toEqual({ teacher })
  })

  it("persists a ta-only teams block", () => {
    const meta = build({ ta })
    expect(meta.teams).toEqual({ ta })
  })

  it("persists a legacy instructor-only teams block", () => {
    const meta = build({ instructor })
    expect(meta.teams).toEqual({ instructor })
  })

  it("persists a full teacher+ta block", () => {
    const meta = build({ teacher, ta })
    expect(meta.teams).toEqual({ teacher, ta })
  })

  it("omits an empty or absent teams block (matches CLI omitempty)", () => {
    expect(build(undefined).teams).toBeUndefined()
    expect(build({}).teams).toBeUndefined()
  })
})
