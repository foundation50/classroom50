import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { STAFF_TEAM_PRIVACY, STUDENT_TEAM_PRIVACY } from "./types"

// The team-privacy split is hand-mirrored between the CLI and the web with no
// compile-time link: staff teams `closed` (GitHub refuses a secret team as a
// ruleset bypass actor), the student team `secret` (its description carries the
// capability secret). Same pattern as the TemplateReadStaffRoles parity test.
describe("team privacy parity with Go configrepo", () => {
  const teamGo = readFileSync(
    path.join(
      process.cwd(),
      "..",
      "cli",
      "gh-teacher",
      "internal",
      "configrepo",
      "team.go",
    ),
    "utf8",
  )

  it("StaffTeamPrivacy matches STAFF_TEAM_PRIVACY", () => {
    const match = teamGo.match(/StaffTeamPrivacy\s*=\s*"([a-z]+)"/)
    expect(match, "StaffTeamPrivacy literal not found in team.go").toBeTruthy()
    expect(match![1]).toBe(STAFF_TEAM_PRIVACY)
  })

  it("studentTeamPrivacy matches STUDENT_TEAM_PRIVACY", () => {
    const match = teamGo.match(/studentTeamPrivacy\s*=\s*"([a-z]+)"/)
    expect(
      match,
      "studentTeamPrivacy literal not found in team.go",
    ).toBeTruthy()
    expect(match![1]).toBe(STUDENT_TEAM_PRIVACY)
  })
})
