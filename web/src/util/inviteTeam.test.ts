import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  INVITE_DESCRIPTION_SCHEMA,
  INVITE_HASH_HEX_LEN,
  INVITE_TEAM_PREFIX,
  inviteTeamName,
  isInviteTeamSlug,
  marshalInviteDescription,
  normalizeInviteEmail,
  parseInviteDescription,
} from "./inviteTeam"

// schemas/invite-v1.schema.json is the source of truth for the record this
// module hand-mirrors, with no compile-time link between them. Assert the two
// agree so a schema edit that isn't mirrored here (or vice versa) fails CI
// instead of silently drifting — same lockstep guard as submissionTags.test.ts.
// The teacher CLI writes and reads these teams too (cli/shared/contract
// InviteTeamPrefix / InviteHashHexLen / InviteSchemaV1, pinned there by
// contract_test.go). There is no compile-time link, so pin the web half too:
// renaming or resizing on this side alone would leave the CLI matching nothing
// and silently stranding invited emails in the org.
describe("invite team name shape — cross-tool contract", () => {
  it("pins the prefix and hash length the CLI expects", () => {
    expect(INVITE_TEAM_PREFIX).toBe("invite-")
    expect(INVITE_HASH_HEX_LEN).toBe(16)
  })
})

describe("classroom50/invite/v1 — shared vector parity with the teacher CLI", () => {
  // Both the web and `gh teacher roster invite` create these teams and each
  // reads the other's, with no compile-time link between the two writers. These
  // vectors are the shared oracle (the Go suite asserts the same file), so a
  // one-sided change to the hash input or the record bytes fails here: it would
  // make every already-created invite team unlocatable and leave the two
  // writers overwriting each other's description forever.
  const fixtureUrl = new URL(
    "../../../cli/shared/testdata/invite_vectors.json",
    import.meta.url,
  )
  const doc = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf8")) as {
    prefix: string
    hash_hex_len: number
    schema: string
    cases: {
      why: string
      classroom: string
      email: string
      slug: string
      record: string
    }[]
  }

  it("addresses the pinned name shape and schema sentinel", () => {
    expect(doc.prefix).toBe(INVITE_TEAM_PREFIX)
    expect(doc.hash_hex_len).toBe(INVITE_HASH_HEX_LEN)
    expect(doc.schema).toBe(INVITE_DESCRIPTION_SCHEMA)
    expect(doc.cases.length).toBeGreaterThan(0)
  })

  for (const c of doc.cases) {
    it(c.why, async () => {
      expect(await inviteTeamName(c.classroom, c.email)).toBe(c.slug)
      // Exact bytes, not a parsed-equal check: a reconcile compares
      // descriptions for string equality.
      expect(marshalInviteDescription(c)).toBe(c.record)
      expect(parseInviteDescription(c.record)).toEqual({
        schema: INVITE_DESCRIPTION_SCHEMA,
        email: normalizeInviteEmail(c.email),
        classroom: c.classroom,
      })
    })
  }
})

describe("classroom50/invite/v1 — schema/mirror parity", () => {
  const schemaUrl = new URL(
    "../../../schemas/invite-v1.schema.json",
    import.meta.url,
  )
  const schema = JSON.parse(readFileSync(fileURLToPath(schemaUrl), "utf8")) as {
    required: string[]
    properties: Record<string, { const?: string }>
  }

  it("matches the schema sentinel", () => {
    expect(schema.properties.schema.const).toBe(INVITE_DESCRIPTION_SCHEMA)
  })

  it("marshals exactly the schema's property set, and all of its required ones", () => {
    const marshaled = JSON.parse(
      marshalInviteDescription({
        email: "alice@example.com",
        classroom: "cs101",
      }),
    ) as Record<string, unknown>
    const marshaledKeys = Object.keys(marshaled).sort()
    // Every declared property is written, and nothing beyond them.
    expect(marshaledKeys).toEqual(Object.keys(schema.properties).sort())
    // Every required field is present in the encoded record.
    for (const key of schema.required) {
      expect(marshaled[key]).toBeTruthy()
    }
  })

  it("parses back a record that satisfies the schema's required set", () => {
    const record = parseInviteDescription(
      marshalInviteDescription({
        email: "alice@example.com",
        classroom: "cs101",
      }),
    )
    expect(record).not.toBeNull()
    for (const key of schema.required) {
      expect(record).toHaveProperty(key)
    }
  })
})

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
    })
    expect(parseInviteDescription(desc)).toEqual({
      schema: INVITE_DESCRIPTION_SCHEMA,
      email: "alice@example.com",
      classroom: "cs101",
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

  it("tolerates unknown fields, including a legacy record's name/section", () => {
    // Additive evolution AND backwards compatibility: an earlier release wrote
    // first_name/last_name/section; the slimmed reader ignores them but still
    // recovers the email.
    const desc = JSON.stringify({
      schema: INVITE_DESCRIPTION_SCHEMA,
      email: "a@b",
      classroom: "cs",
      first_name: "Alice",
      section: "S1",
      futureField: "x",
    })
    const parsed = parseInviteDescription(desc)
    expect(parsed?.email).toBe("a@b")
    expect(parsed?.classroom).toBe("cs")
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
  it("encodes exactly schema + email + classroom (PII-minimal)", () => {
    const out = marshalInviteDescription({
      email: "alice@example.com",
      classroom: "cs101",
    })
    expect(JSON.parse(out)).toEqual({
      schema: INVITE_DESCRIPTION_SCHEMA,
      email: "alice@example.com",
      classroom: "cs101",
    })
  })

  it("normalizes the stored email", () => {
    const out = marshalInviteDescription({
      email: "  ALICE@Example.com ",
      classroom: "cs101",
    })
    expect(JSON.parse(out).email).toBe("alice@example.com")
  })

  it("round-trips through parseInviteDescription", () => {
    const out = marshalInviteDescription({
      email: "alice@example.com",
      classroom: "cs101",
    })
    expect(parseInviteDescription(out)).toEqual({
      schema: INVITE_DESCRIPTION_SCHEMA,
      email: "alice@example.com",
      classroom: "cs101",
    })
  })

  it("stays far under GitHub's ~250-char description cap for a long email", () => {
    const out = marshalInviteDescription({
      email: `${"x".repeat(64)}@${"y".repeat(60)}.example.com`,
      classroom: "a-fairly-long-classroom-name",
    })
    expect(out.length).toBeLessThanOrEqual(240)
  })

  it("escapes <, >, & (Go json.Marshal parity)", () => {
    const out = marshalInviteDescription({
      email: "a&b<c>@x",
      classroom: "cs",
    })
    expect(out).toContain("\\u0026")
    expect(out).toContain("\\u003c")
    expect(out).toContain("\\u003e")
    expect(out).not.toMatch(/[<>&]/)
    expect(parseInviteDescription(out)?.email).toBe("a&b<c>@x")
  })

  it("escapes U+2028/U+2029 line/paragraph separators (Go parity)", () => {
    const out = marshalInviteDescription({
      email: "a@b",
      classroom: "cs\u2028x\u2029y",
    })
    expect(out).toContain("\\u2028")
    expect(out).toContain("\\u2029")
    expect(out).not.toMatch(/[\u2028\u2029]/)
    expect(parseInviteDescription(out)?.classroom).toBe("cs\u2028x\u2029y")
  })

  // The other half of the parity contract: Go's json.Marshal agrees with
  // JSON.stringify on EVERY C0 control and DEL, so the escaper must leave them
  // all alone. Escaping \b/\f as \u0008/\u000c "for Go parity" would be the bug.
  // Exhaustive over U+0000–U+001F rather than a sample, because the escaper's
  // claim is that <, >, & and U+2028/U+2029 are the ONLY divergences.
  it("leaves every C0 control and DEL exactly as JSON.stringify writes them (Go parity)", () => {
    // The five controls JSON.stringify gives a short escape; every other C0
    // control takes the lowercase \u00xx form.
    const shortEscapes = new Map([
      [0x08, "\\b"],
      [0x09, "\\t"],
      [0x0a, "\\n"],
      [0x0c, "\\f"],
      [0x0d, "\\r"],
    ])
    for (let cp = 0; cp <= 0x1f; cp++) {
      const classroom = `cs${String.fromCharCode(cp)}x`
      const out = marshalInviteDescription({ email: "a@b", classroom })
      const long = `\\u${cp.toString(16).padStart(4, "0")}`
      const short = shortEscapes.get(cp)
      expect(out, `U+${cp.toString(16)}`).toContain(short ?? long)
      if (short) expect(out, `U+${cp.toString(16)}`).not.toContain(long)
      // An uppercase-hex escape would be a byte difference on its own.
      expect(out).not.toContain(long.toUpperCase())
      expect(parseInviteDescription(out)?.classroom).toBe(classroom)
    }
    // DEL is escaped by neither encoder.
    const del = marshalInviteDescription({
      email: "a@b",
      classroom: "cs\u007fx",
    })
    expect(del).toContain("\u007f")
    expect(del).not.toContain("\\u007f")
  })
})
