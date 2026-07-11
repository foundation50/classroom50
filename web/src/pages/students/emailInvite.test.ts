import { describe, expect, it } from "vitest"
import { parseEmailInviteFile } from "./emailInvite"

describe("parseEmailInviteFile", () => {
  it("parses one valid email per line", () => {
    const text = "ada@uni.edu\nbob@example.com\n"
    expect(parseEmailInviteFile(text).map((r) => r.email)).toEqual([
      "ada@uni.edu",
      "bob@example.com",
    ])
  })

  it("trims whitespace and strips a leading mailto:", () => {
    const text = "  ada@uni.edu  \nmailto:bob@example.com\nMAILTO:cara@x.io\n"
    expect(parseEmailInviteFile(text).map((r) => r.email)).toEqual([
      "ada@uni.edu",
      "bob@example.com",
      "cara@x.io",
    ])
  })

  it("drops lines that are not valid emails (incl. bare usernames)", () => {
    const text = "ada@uni.edu\nnot-an-email\noctocat\n@handle\nbob@x\n"
    expect(parseEmailInviteFile(text).map((r) => r.email)).toEqual([
      "ada@uni.edu",
    ])
  })

  it("dedupes case-insensitively, keeping the first occurrence", () => {
    const text = "Ada@Uni.edu\nada@uni.edu\nADA@UNI.EDU\n"
    const rows = parseEmailInviteFile(text)
    expect(rows).toHaveLength(1)
    expect(rows[0].email).toBe("Ada@Uni.edu")
  })

  it("leaves role undefined (chosen in the UI, not the file)", () => {
    expect(parseEmailInviteFile("ada@uni.edu\n")[0].role).toBeUndefined()
  })

  it("returns an empty array for empty or whitespace-only input", () => {
    expect(parseEmailInviteFile("")).toEqual([])
    expect(parseEmailInviteFile("  \n \n")).toEqual([])
  })
})
