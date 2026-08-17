import { describe, expect, it } from "vitest"
import {
  coerceImportRole,
  detectImportHeaderIssue,
  parseRosterImportFile,
} from "./UploadRoster"

// The parser returns UNRESOLVED identities: it records the file's cells and
// leaves trading a github_id for a login to rosterImportResolve (that needs the
// network). These tests therefore assert on identity cells, not final logins.
const parse = (text: string, kind?: "roster-csv" | "username-list") =>
  parseRosterImportFile(text, kind)

describe("parseRosterImportFile", () => {
  it("parses a CSV with a username header and full metadata columns", () => {
    const csv =
      "username,first_name,last_name,email,section\n" +
      "ada,Ada,Lovelace,ada@uni.edu,Lab 1\n"
    expect(parse(csv).rows).toEqual([
      {
        identity: { username: "ada", email: "ada@uni.edu" },
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@uni.edu",
        section: "Lab 1",
      },
    ])
  })

  it("splits a single `name` column into first/last when first/last are absent", () => {
    const csv = "username,name,section\ngrace,Grace Hopper,P2\n"
    expect(parse(csv).rows[0]).toMatchObject({
      identity: { username: "grace" },
      first_name: "Grace",
      last_name: "Hopper",
      section: "P2",
    })
  })

  it("is column-order- and case-insensitive on headers", () => {
    const csv = "Email,USERNAME,First_Name\nbob@uni.edu,bob,Bob\n"
    expect(parse(csv).rows[0]).toMatchObject({
      identity: { username: "bob", email: "bob@uni.edu" },
      first_name: "Bob",
    })
  })

  it("reads a github_id column as the row's identity", () => {
    const csv = "username,github_id\ncara,999999\n"
    expect(parse(csv).rows[0]?.identity).toEqual({
      githubId: 999999,
      username: "cara",
    })
  })

  it("tolerates a leading-zero github_id but rejects an Excel-mangled one", () => {
    expect(parse("github_id\n0583231\n").rows[0]?.identity).toEqual({
      githubId: 583231,
    })
    // 5.83231E+05 and 0x10 must never coerce into a valid-LOOKING id.
    const mangled = parse("github_id\n5.83231E+05\n").rows[0]?.identity
    expect(mangled?.githubId).toBeUndefined()
    expect(mangled?.malformedGithubId).toBe("5.83231E+05")
  })

  it("accepts an email-only row as an email identity", () => {
    const csv = "email,first_name,section\nzoe@uni.edu,Zoe,Lab 2\n"
    expect(parse(csv).rows[0]).toMatchObject({
      identity: { email: "zoe@uni.edu" },
      first_name: "Zoe",
      section: "Lab 2",
    })
  })

  it("keeps every identity cell so precedence can be applied after resolution", () => {
    const csv = "github_id,username,email\n42,ada,ada@uni.edu\n"
    expect(parse(csv).rows[0]?.identity).toEqual({
      githubId: 42,
      username: "ada",
      email: "ada@uni.edu",
    })
  })

  it("drops a row whose email cell is not a valid address", () => {
    const csv = "email,first_name\nn/a,Nobody\nok@uni.edu,Ok\n"
    const parsed = parse(csv)
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.dropped).toEqual([{ line: 2, reason: "bad-email" }])
  })

  it("reads a bare list per line, detecting addresses and handles", () => {
    const text = "ada\nbob@uni.edu\n@carol\nmailto:dan@uni.edu\n"
    expect(parse(text).rows.map((r) => r.identity)).toEqual([
      { username: "ada" },
      { email: "bob@uni.edu" },
      { username: "carol" }, // leading @ stripped by normalizeGithubUsername
      { email: "dan@uni.edu" },
    ])
  })

  it("treats a bare digits line as a username, not a github_id", () => {
    // isLikelyGithubUsername("12345") is true, and only a github_id COLUMN means
    // an id — otherwise a handle like `12345` would silently become an account id.
    expect(parse("12345\n").rows[0]?.identity).toEqual({ username: "12345" })
  })

  it("forces every bare line to a handle under the username-list override", () => {
    const text = "ada\nbob@uni.edu\n"
    expect(parse(text, "username-list").rows.map((r) => r.identity)).toEqual([
      { username: "ada" },
      // Not a plausible handle (dots and @), so it drops rather than becoming an
      // email identity — the teacher asserted this file is handles.
    ])
  })

  it("drops rows whose username is missing or not a valid GitHub handle", () => {
    const csv = "username,first_name\n,Nobody\n-bad-,Bad\nvalid-user,Ok\n"
    expect(parse(csv).rows.map((r) => r.identity.username)).toEqual([
      "valid-user",
    ])
  })

  it("keeps the raw email cell as metadata so an unchanged roster shows no delta", () => {
    // Stored roster addresses are never lower-cased, and mergeStudentMetadata
    // compares case-sensitively — so normalizing here would report a metadata
    // change on every row whose address has a capital letter.
    const csv = "username,email\nada,Ada@Uni.edu\n"
    const parsed = parse(csv).rows[0]
    expect(parsed?.email).toBe("Ada@Uni.edu")
    // The identity still normalizes, since that's what addresses the invite.
    expect(parsed?.identity.email).toBe("ada@uni.edu")
  })

  it("returns no rows for empty or whitespace-only input", () => {
    expect(parse("").rows).toEqual([])
    expect(parse("   \n  ").rows).toEqual([])
  })

  it("does not import its own header row for a single-column CSV", () => {
    // Papa emits only the benign Delimiter warning here, which used to force the
    // headerless fallback and import a student literally named "username".
    expect(parse("username\nada\nbob\n").rows.map((r) => r.identity)).toEqual([
      { username: "ada" },
      { username: "bob" },
    ])
  })

  it("returns no rows for a structurally malformed CSV", () => {
    // A ragged row means the columns can't be trusted, so we must NOT silently
    // re-read the file as a bare handle list; the caller surfaces `malformed`.
    const csv = 'username,email\nada,"unclosed\nbob,b@x.io\n'
    expect(parse(csv).rows).toEqual([])
  })

  it("parses a role column into the row role (case-insensitive)", () => {
    const csv =
      "username,role\nada,student\nprof,Teacher\nhelper,TA\nghost,dean\n"
    expect(parse(csv).rows.map((r) => [r.identity.username, r.role])).toEqual([
      ["ada", "student"],
      ["prof", "teacher"],
      ["helper", "ta"],
      ["ghost", undefined], // unrecognized -> undefined (upload defaults student)
    ])
  })
})

describe("detectImportHeaderIssue", () => {
  it("flags a header row with no identity column", () => {
    const csv = "first_name,last_name,section\nAda,Lovelace,Lab 1\n"
    const issue = detectImportHeaderIssue(csv)
    expect(issue?.kind).toBe("missing-identity-header")
    if (issue?.kind === "missing-identity-header") {
      expect(issue.present).toEqual(["first_name", "last_name", "section"])
      // Advertises the three identity columns, in precedence order.
      expect(issue.identity).toEqual(["github_id", "username", "email"])
    }
  })

  it("does NOT flag a lone github_id or email column — both identify a row", () => {
    expect(detectImportHeaderIssue("github_id\n123\n")).toBeNull()
    expect(detectImportHeaderIssue("email\na@x.io\n")).toBeNull()
  })

  it("flags a single recognized-but-non-identifying header column", () => {
    expect(detectImportHeaderIssue("section\nLab 1\n")?.kind).toBe(
      "missing-identity-header",
    )
  })

  it("does NOT flag a bare one-value-per-line list", () => {
    expect(detectImportHeaderIssue("ada\nbob\n@carol\n")).toBeNull()
  })

  it("does NOT flag a valid file that has an identity column", () => {
    expect(detectImportHeaderIssue("username,email\nada,a@x.io\n")).toBeNull()
    expect(detectImportHeaderIssue("Email,USERNAME\na@x.io,ada\n")).toBeNull()
  })

  it("reports a structurally malformed CSV", () => {
    const csv = 'username,email\nada,"unclosed\nbob,b@x.io\n'
    expect(detectImportHeaderIssue(csv)?.kind).toBe("malformed")
  })

  it("returns null for empty or whitespace-only input", () => {
    expect(detectImportHeaderIssue("")).toBeNull()
    expect(detectImportHeaderIssue("   \n ")).toBeNull()
  })
})

describe("coerceImportRole", () => {
  it("accepts the known roles, case-insensitively", () => {
    expect(coerceImportRole("student")).toBe("student")
    expect(coerceImportRole("teacher")).toBe("teacher")
    expect(coerceImportRole("ta")).toBe("ta")
    expect(coerceImportRole("hta")).toBe("hta")
    expect(coerceImportRole("HTA")).toBe("hta")
    expect(coerceImportRole("Teacher")).toBe("teacher")
    expect(coerceImportRole("  TA  ")).toBe("ta")
  })

  it("returns undefined for an unknown, empty, or missing value", () => {
    expect(coerceImportRole("dean")).toBeUndefined()
    expect(coerceImportRole("")).toBeUndefined()
    expect(coerceImportRole(undefined)).toBeUndefined()
    // Not a silent alias for admin/owner — an unknown role never escalates.
    expect(coerceImportRole("admin")).toBeUndefined()
    expect(coerceImportRole("owner")).toBeUndefined()
  })
})
