import { describe, expect, it } from "vitest"
import { parseTeamDescription } from "./teamDescription"

describe("parseTeamDescription", () => {
  it("parses a valid v1 record", () => {
    const desc = JSON.stringify({
      schema: "classroom50/team/v1",
      name: "Intro CS",
      term: "Fall 2026",
      secret: "a1b2c3d4",
    })
    expect(parseTeamDescription(desc)).toEqual({
      schema: "classroom50/team/v1",
      name: "Intro CS",
      term: "Fall 2026",
      secret: "a1b2c3d4",
    })
  })

  it("returns no secret for a listed classroom", () => {
    const desc = JSON.stringify({ schema: "classroom50/team/v1", name: "CS" })
    const parsed = parseTeamDescription(desc)
    expect(parsed.name).toBe("CS")
    expect(parsed.secret).toBeUndefined()
  })

  it("drops a malformed secret rather than failing the parse", () => {
    const desc = JSON.stringify({
      schema: "classroom50/team/v1",
      name: "CS",
      secret: "BAD secret!",
    })
    const parsed = parseTeamDescription(desc)
    expect(parsed.name).toBe("CS")
    expect(parsed.secret).toBeUndefined()
  })

  it("ignores unknown future fields (additive evolution)", () => {
    const desc = JSON.stringify({
      schema: "classroom50/team/v1",
      name: "CS",
      futureField: "x",
    })
    const parsed = parseTeamDescription(desc)
    expect(parsed.name).toBe("CS")
    expect(parsed.schema).toBe("classroom50/team/v1")
  })

  it("returns {} for a plain-text (pre-schema) description", () => {
    expect(parseTeamDescription("Students of CS101")).toEqual({})
  })

  it("returns {} for a wrong/absent schema sentinel", () => {
    expect(
      parseTeamDescription(JSON.stringify({ schema: "other", secret: "abcd" })),
    ).toEqual({})
  })

  it("returns {} for null, undefined, or empty", () => {
    expect(parseTeamDescription(null)).toEqual({})
    expect(parseTeamDescription(undefined)).toEqual({})
    expect(parseTeamDescription("")).toEqual({})
  })
})
