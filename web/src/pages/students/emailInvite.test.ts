import { describe, expect, it } from "vitest"
import { parseEmailInviteFile } from "./emailInvite"

describe("parseEmailInviteFile", () => {
  it("parses one valid email per line", () => {
    const text = "ada@uni.edu\nbob@example.com\n"
    const parsed = parseEmailInviteFile(text)
    expect(parsed.valid.map((r) => r.email)).toEqual([
      "ada@uni.edu",
      "bob@example.com",
    ])
    expect(parsed.invalid).toEqual([])
  })

  it("trims whitespace and strips a leading mailto:", () => {
    const text = "  ada@uni.edu  \nmailto:bob@example.com\nMAILTO:cara@x.io\n"
    expect(parseEmailInviteFile(text).valid.map((r) => r.email)).toEqual([
      "ada@uni.edu",
      "bob@example.com",
      "cara@x.io",
    ])
  })

  it("collects invalid non-empty lines with their file line numbers", () => {
    const text = "ada@uni.edu\nnot-an-email\noctocat\n@handle\nbob@x\n"
    const parsed = parseEmailInviteFile(text)
    expect(parsed.valid.map((r) => r.email)).toEqual(["ada@uni.edu"])
    expect(parsed.invalid).toEqual([
      { line: 2, value: "not-an-email" },
      { line: 3, value: "octocat" },
      { line: 4, value: "@handle" },
      { line: 5, value: "bob@x" },
    ])
  })

  it("skips empty and whitespace-only lines silently (not invalid)", () => {
    const text = "ada@uni.edu\n\n   \nbob@example.com\n"
    const parsed = parseEmailInviteFile(text)
    expect(parsed.valid.map((r) => r.email)).toEqual([
      "ada@uni.edu",
      "bob@example.com",
    ])
    expect(parsed.invalid).toEqual([])
  })

  it("reports the correct line number when blank lines precede an invalid one", () => {
    const text = "\nada@uni.edu\n\nnope\n"
    expect(parseEmailInviteFile(text).invalid).toEqual([
      { line: 4, value: "nope" },
    ])
  })

  it("dedupes valid emails case-insensitively, keeping the first occurrence", () => {
    const text = "Ada@Uni.edu\nada@uni.edu\nADA@UNI.EDU\n"
    const parsed = parseEmailInviteFile(text)
    expect(parsed.valid).toHaveLength(1)
    expect(parsed.valid[0].email).toBe("Ada@Uni.edu")
  })

  it("leaves role undefined (chosen in the UI, not the file)", () => {
    expect(parseEmailInviteFile("ada@uni.edu\n").valid[0].role).toBeUndefined()
  })

  it("returns empty valid+invalid for empty or whitespace-only input", () => {
    expect(parseEmailInviteFile("")).toEqual({ valid: [], invalid: [] })
    expect(parseEmailInviteFile("  \n \n")).toEqual({ valid: [], invalid: [] })
  })
})
