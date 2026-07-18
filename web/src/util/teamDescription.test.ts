import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { marshalTeamDescription, parseTeamDescription } from "./teamDescription"

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

describe("marshalTeamDescription", () => {
  it("encodes an unlisted active classroom with secret, omitting active", () => {
    const out = marshalTeamDescription({
      name: "Intro CS",
      term: "Fall 2026",
      secret: "a1b2c3d4",
      active: true,
    })
    expect(JSON.parse(out)).toEqual({
      schema: "classroom50/team/v1",
      name: "Intro CS",
      term: "Fall 2026",
      secret: "a1b2c3d4",
    })
  })

  it("omits empty name/term and the secret for a listed classroom", () => {
    const out = marshalTeamDescription({ name: "CS", active: true })
    expect(JSON.parse(out)).toEqual({
      schema: "classroom50/team/v1",
      name: "CS",
    })
  })

  it("drops a malformed secret rather than persisting it", () => {
    const out = marshalTeamDescription({
      name: "CS",
      secret: "BAD secret!",
      active: true,
    })
    expect(JSON.parse(out).secret).toBeUndefined()
  })

  it("emits active:false for an archived classroom", () => {
    const out = marshalTeamDescription({ name: "CS", active: false })
    expect(JSON.parse(out).active).toBe(false)
  })

  it("round-trips through parseTeamDescription", () => {
    const out = marshalTeamDescription({
      name: "Intro CS",
      term: "Fall 2026",
      secret: "a1b2c3d4",
      active: true,
    })
    expect(parseTeamDescription(out)).toEqual({
      schema: "classroom50/team/v1",
      name: "Intro CS",
      term: "Fall 2026",
      secret: "a1b2c3d4",
    })
  })

  it("escapes <, >, &, U+2028, U+2029 to match Go's json.Marshal (byte-identical contract)", () => {
    // Go's json.Marshal escapes all five by default; JSON.stringify escapes
    // none. Without matching, the CLI and web would perpetually rewrite each
    // other's description for a classroom whose name/term contains them.
    const out = marshalTeamDescription({ name: "C++ & <Data>", active: true })
    expect(out).toContain("\\u0026")
    expect(out).toContain("\\u003c")
    expect(out).toContain("\\u003e")
    expect(out).not.toMatch(/[<>&]/)
    // Still valid JSON that parses back to the original name.
    expect(parseTeamDescription(out).name).toBe("C++ & <Data>")

    // Line/paragraph separators (a common paste vector) are the only other
    // divergence Go escapes; pin them explicitly.
    const seps = marshalTeamDescription({
      name: "a\u2028b\u2029c",
      active: true,
    })
    expect(seps).toContain("\\u2028")
    expect(seps).toContain("\\u2029")
    expect(seps).not.toMatch(/[\u2028\u2029]/)
    expect(parseTeamDescription(seps).name).toBe("a\u2028b\u2029c")
  })
})

// Cross-language byte-identity: the same golden cases the Go
// MarshalTeamDescription asserts (cli/gh-teacher/internal/configrepo/
// teamdescription_test.go). A drift on either side fails here — the web
// reconcile compares exact strings, so divergence causes perpetual rewrites.
describe("marshalTeamDescription — shared fixture parity", () => {
  const fixtureUrl = new URL(
    "../../../cli/shared/testdata/team_description_cases.json",
    import.meta.url,
  )
  const doc = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf8")) as {
    cases: {
      input: { name?: string; term?: string; secret?: string; active: boolean }
      encoded: string
    }[]
  }

  it("has cases", () => {
    expect(doc.cases.length).toBeGreaterThan(0)
  })

  for (const [i, c] of doc.cases.entries()) {
    it(`case ${i} encodes byte-identically to the Go writer`, () => {
      expect(marshalTeamDescription(c.input)).toBe(c.encoded)
    })
  }
})
