import { describe, expect, it } from "vitest"
import { classroomTeamSlug } from "./teamSlug"

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
