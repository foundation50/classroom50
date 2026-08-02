import { describe, expect, it } from "vitest"
import { createClassroomMetadata } from "./gitObjects"
import type { StaffTeamRefs } from "./teams"

// Pins the classroom.json `teams` persistence gate in createClassroomMetadata.
// A too-narrow gate reading only (teams.teacher || teams.ta) would silently
// drop the teams block for an hta-only classroom on create. These assert every
// staff-role-only block is persisted (and that an empty/absent block is still
// omitted, matching the CLI's `omitempty`).
describe("createClassroomMetadata teams persistence", () => {
  const teacher = { id: 1, slug: "classroom50-cs-teacher" }
  const ta = { id: 2, slug: "classroom50-cs-ta" }
  const hta = { id: 3, slug: "classroom50-cs-hta" }

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

  it("persists an hta-only teams block", () => {
    const meta = build({ hta })
    expect(meta.teams).toEqual({ hta })
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
