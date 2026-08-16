import { describe, expect, it } from "vitest"
import {
  INVITE_DESCRIPTION_SCHEMA,
  INVITE_TEAM_PREFIX,
  inviteTeamName,
  isInviteTeamSlug,
  marshalInviteDescription,
  normalizeInviteEmail,
  parseInviteDescription,
} from "./inviteTeam"

describe("normalizeInviteEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeInviteEmail("  Alice@Example.COM ")).toBe(
      "alice@example.com",
    )
  })
})

describe("inviteTeamName", () => {
  it("is deterministic, slug-safe, and 23 chars (invite- + 16 hex)", async () => {
    const name = await inviteTeamName("cs101", "alice@example.com")
    expect(name).toMatch(/^invite-[0-9a-f]{16}$/)
    expect(name).toHaveLength(INVITE_TEAM_PREFIX.length + 16)
    // Slug-safe: GitHub derives the slug unchanged (lowercase, hyphen, no
    // special chars), so name === slug.
    expect(name).toBe(name.toLowerCase())
    const again = await inviteTeamName("cs101", "alice@example.com")
    expect(again).toBe(name)
  })

  it("normalizes the email before hashing (case/whitespace insensitive)", async () => {
    const a = await inviteTeamName("cs101", "alice@example.com")
    const b = await inviteTeamName("cs101", "  ALICE@Example.com  ")
    expect(b).toBe(a)
  })

  it("scopes by classroom: same email in two classrooms -> distinct names", async () => {
    const a = await inviteTeamName("cs101", "alice@example.com")
    const b = await inviteTeamName("cs102", "alice@example.com")
    expect(a).not.toBe(b)
  })

  it("does not collide on the classroom/email boundary", async () => {
    // Without a separator byte, ("ab","c") and ("a","bc") would hash the same
    // input. The \u0000 separator prevents this.
    const a = await inviteTeamName("ab", "c@x")
    const b = await inviteTeamName("a", "bc@x")
    expect(a).not.toBe(b)
  })
})

describe("isInviteTeamSlug", () => {
  it("recognizes invite- teams and rejects others", () => {
    expect(isInviteTeamSlug("invite-0123456789abcdef")).toBe(true)
    expect(isInviteTeamSlug("classroom50-cs101")).toBe(false)
    expect(isInviteTeamSlug("classroom50-cs101-teacher")).toBe(false)
  })
})

describe("parseInviteDescription", () => {
  it("parses a valid v1 record", () => {
    const desc = JSON.stringify({
      schema: INVITE_DESCRIPTION_SCHEMA,
      email: "alice@example.com",
      classroom: "cs101",
      first_name: "Alice",
      last_name: "Ng",
      section: "S1",
    })
    expect(parseInviteDescription(desc)).toEqual({
      schema: INVITE_DESCRIPTION_SCHEMA,
      email: "alice@example.com",
      classroom: "cs101",
      first_name: "Alice",
      last_name: "Ng",
      section: "S1",
    })
  })

  it("requires email and classroom", () => {
    expect(
      parseInviteDescription(
        JSON.stringify({ schema: INVITE_DESCRIPTION_SCHEMA, email: "a@b" }),
      ),
    ).toBeNull()
    expect(
      parseInviteDescription(
        JSON.stringify({ schema: INVITE_DESCRIPTION_SCHEMA, classroom: "cs" }),
      ),
    ).toBeNull()
  })

  it("ignores unknown future fields (additive evolution)", () => {
    const desc = JSON.stringify({
      schema: INVITE_DESCRIPTION_SCHEMA,
      email: "a@b",
      classroom: "cs",
      futureField: "x",
    })
    expect(parseInviteDescription(desc)?.email).toBe("a@b")
  })

  it("returns null for wrong schema, plain text, non-JSON, null/empty", () => {
    expect(
      parseInviteDescription(
        JSON.stringify({ schema: "other", email: "a@b", classroom: "cs" }),
      ),
    ).toBeNull()
    expect(parseInviteDescription("just a team")).toBeNull()
    expect(parseInviteDescription("{not json")).toBeNull()
    expect(parseInviteDescription(null)).toBeNull()
    expect(parseInviteDescription(undefined)).toBeNull()
    expect(parseInviteDescription("")).toBeNull()
  })
})

describe("marshalInviteDescription", () => {
  it("encodes required fields plus non-empty display fields", () => {
    const out = marshalInviteDescription({
      email: "alice@example.com",
      classroom: "cs101",
      first_name: "Alice",
      last_name: "Ng",
      section: "S1",
    })
    expect(JSON.parse(out)).toEqual({
      schema: INVITE_DESCRIPTION_SCHEMA,
      email: "alice@example.com",
      classroom: "cs101",
      first_name: "Alice",
      last_name: "Ng",
      section: "S1",
    })
  })

  it("normalizes the stored email and omits empty display fields", () => {
    const out = marshalInviteDescription({
      email: "  ALICE@Example.com ",
      classroom: "cs101",
      first_name: "  ",
    })
    expect(JSON.parse(out)).toEqual({
      schema: INVITE_DESCRIPTION_SCHEMA,
      email: "alice@example.com",
      classroom: "cs101",
    })
  })

  it("round-trips through parseInviteDescription", () => {
    const out = marshalInviteDescription({
      email: "alice@example.com",
      classroom: "cs101",
      first_name: "Alice",
    })
    expect(parseInviteDescription(out)).toEqual({
      schema: INVITE_DESCRIPTION_SCHEMA,
      email: "alice@example.com",
      classroom: "cs101",
      first_name: "Alice",
    })
  })

  it("drops display fields to fit the byte budget, preserving email/classroom", () => {
    const longName = "x".repeat(300)
    const out = marshalInviteDescription({
      email: "alice@example.com",
      classroom: "cs101",
      first_name: longName,
      last_name: longName,
      section: longName,
    })
    const parsed = parseInviteDescription(out)
    expect(parsed?.email).toBe("alice@example.com")
    expect(parsed?.classroom).toBe("cs101")
    // The oversized display fields were dropped to stay within budget.
    expect(parsed?.first_name).toBeUndefined()
    expect(parsed?.last_name).toBeUndefined()
    expect(parsed?.section).toBeUndefined()
    expect(out.length).toBeLessThanOrEqual(240)
  })

  it("escapes <, >, & (Go json.Marshal parity)", () => {
    const out = marshalInviteDescription({
      email: "a@b",
      classroom: "cs",
      first_name: "C++ & <Data>",
    })
    expect(out).toContain("\\u0026")
    expect(out).toContain("\\u003c")
    expect(out).toContain("\\u003e")
    expect(out).not.toMatch(/[<>&]/)
    expect(parseInviteDescription(out)?.first_name).toBe("C++ & <Data>")
  })

  it("escapes U+2028/U+2029 line/paragraph separators (Go parity)", () => {
    const out = marshalInviteDescription({
      email: "a@b",
      classroom: "cs",
      first_name: "a\u2028b\u2029c",
    })
    expect(out).toContain("\\u2028")
    expect(out).toContain("\\u2029")
    expect(out).not.toMatch(/[\u2028\u2029]/)
    expect(parseInviteDescription(out)?.first_name).toBe("a\u2028b\u2029c")
  })
})
