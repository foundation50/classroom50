import { describe, expect, it } from "vitest"
import {
  ROSTER_TEMPLATE_CSV,
  coerceImportRole,
  detectImportHeaderIssue,
  parseRosterImportFile,
} from "./UploadRoster"
import type { UploadKind } from "./uploadClassify"

// The parser returns UNRESOLVED identities: it records the file's cells and
// leaves trading a github_id for a login to rosterImportResolve (that needs the
// network). These tests therefore assert on identity cells, not final logins.
const parse = (text: string, kind?: UploadKind) =>
  parseRosterImportFile(text, kind)

describe("parseRosterImportFile", () => {
  it("parses a CSV with a username header and full metadata columns", () => {
    const csv =
      "username,first_name,last_name,email,section\n" +
      "ada,Ada,Lovelace,ada@uni.edu,Lab 1\n"
    expect(parse(csv).rows).toEqual([
      {
        line: 2,
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
    // The offending cell rides along so the preview can quote it — telling the
    // teacher the address was "missing" when they typed `n/a` is what the old
    // single count-only message did.
    expect(parsed.dropped).toEqual([
      { line: 2, reason: "bad-email", value: "n/a" },
    ])
  })

  it("blames the username cell when it holds content that isn't a handle", () => {
    // A leading hyphen fails isLikelyGithubUsername. Reported as a bad username
    // rather than as an empty row, which is what makes the import block: content
    // we couldn't read means the FILE is wrong.
    const parsed = parse("username,first_name\n-bad-,Ann\n")
    expect(parsed.rows).toHaveLength(0)
    expect(parsed.dropped).toEqual([
      { line: 2, reason: "bad-username", value: "-bad-" },
    ])
  })

  // A reported line number is the teacher's only handle on the row to edit, and
  // both the trim and Papa's blank-row skipping would otherwise shift it.
  describe("reports the TRUE file line", () => {
    it("counts leading blank lines", () => {
      expect(parse("\n\nusername\nada\n-bad-\n").dropped).toEqual([
        { line: 5, reason: "bad-username", value: "-bad-" },
      ])
    })

    it("counts an interior blank line", () => {
      expect(parse("username\nada\n\n-bad-\n").dropped).toEqual([
        { line: 4, reason: "bad-username", value: "-bad-" },
      ])
    })

    it("counts an all-blank-cell row, which Papa also skips", () => {
      expect(parse("username,email\nada,\n,\n-bad-,\n").dropped).toEqual([
        { line: 4, reason: "bad-username", value: "-bad-" },
      ])
    })

    it("counts CRLF line endings", () => {
      expect(parse("username\r\nada\r\n\r\n-bad-\r\n").dropped).toEqual([
        { line: 4, reason: "bad-username", value: "-bad-" },
      ])
    })

    it("counts leading blank lines in a bare list", () => {
      expect(parse("\n\nada\nJohn Smith\n").dropped).toEqual([
        { line: 4, reason: "bad-value", value: "John Smith" },
      ])
    })

    it("counts a newline inside a quoted field", () => {
      // The row spans lines 2-3, so the row AFTER it is on line 4. Deriving lines
      // by splitting on newlines would report 3 and send the teacher to the middle
      // of someone else's row.
      const csv = 'username,note\nada,"one\ntwo"\n-bad-,x\n'
      expect(parse(csv).dropped).toEqual([
        { line: 4, reason: "bad-username", value: "-bad-" },
      ])
    })

    it("is unaffected by a leading BOM", () => {
      // Excel's "CSV UTF-8" writes one. The BOM is stripped up front so the
      // cursor arithmetic doesn't rely on its offset shift happening to cancel out.
      expect(parse("\uFEFFusername\nada\n-bad-\n").dropped).toEqual([
        { line: 3, reason: "bad-username", value: "-bad-" },
      ])
      // And the first header is still recognised, rather than read as "\uFEFFusername".
      expect(parse("\uFEFFusername\nada\n").rows[0]?.identity).toEqual({
        username: "ada",
      })
    })

    it("counts a last row that has no trailing newline", () => {
      // Papa ends that row's cursor at the input length rather than past a newline,
      // so without compensating it would inherit the previous row's number.
      expect(parse("username\nada\n-bad-").dropped).toEqual([
        { line: 3, reason: "bad-username", value: "-bad-" },
      ])
    })

    it("keeps consecutive unterminated bad rows distinct", () => {
      // Two rows reported against one line also collide as React keys in the list.
      expect(parse("username\n-b1-\n-b2-").dropped).toEqual([
        { line: 2, reason: "bad-username", value: "-b1-" },
        { line: 3, reason: "bad-username", value: "-b2-" },
      ])
    })

    it("counts lone-CR line endings", () => {
      // A legacy Mac / older Excel export. Counting only LF would report every row
      // as line 1 — and identical line+reason pairs collide as React keys.
      expect(parse("username\rada\r-bad-\r").dropped).toEqual([
        { line: 3, reason: "bad-username", value: "-bad-" },
      ])
    })

    it("counts lone-CR line endings in a bare list", () => {
      expect(parse("ada\rJohn Smith\r").dropped).toEqual([
        { line: 2, reason: "bad-value", value: "John Smith" },
      ])
    })
  })

  it("yields nothing for a headered CSV with no identity column", () => {
    // A SHAPE problem, not a row-content one. Re-reading such a file one value per
    // line would blame the header and every data row for not being a username,
    // burying the one message that helps — which detectImportHeaderIssue provides.
    const csv = "first_name,last_name\nAda,Lovelace\nGrace,Hopper\n"
    expect(parse(csv)).toEqual({ rows: [], dropped: [], unlinked: [] })
    expect(detectImportHeaderIssue(csv)?.kind).toBe("missing-identity-header")
  })

  it("skips a recognized column caption instead of importing it as a student", () => {
    // A spreadsheet export of a single column starts with that column's title.
    // `username` is handle-shaped, so without this it would import as a student.
    const parsed = parse("username\nada\nbob\n")
    expect(parsed.rows.map((r) => r.identity)).toEqual([
      { username: "ada" },
      { username: "bob" },
    ])
    expect(parsed.dropped).toEqual([])
  })

  it("reports an unrecognized bad first line rather than guessing it's a caption", () => {
    // "Didn't parse, but a later line did" describes a typo'd first entry just as
    // well as a caption — guessing would silently omit a student the teacher listed.
    const parsed = parse("GitHub Username\nada\n")
    expect(parsed.rows.map((r) => r.identity)).toEqual([{ username: "ada" }])
    expect(parsed.dropped).toEqual([
      { line: 1, reason: "bad-value", value: "GitHub Username" },
    ])
  })

  it("still reports the first line when nothing else parses either", () => {
    const parsed = parse("Student Name\nAnother Name\n")
    expect(parsed.rows).toHaveLength(0)
    expect(parsed.dropped.map((d) => d.line)).toEqual([1, 2])
  })

  it("keeps a name-only row as UNLINKED and reports a nameless one as incomplete", () => {
    // A named row without any identity cell is a student who hasn't supplied a
    // handle yet — kept on the roster as an unlinked row for manual linking. A
    // row with neither identity nor name (section-only noise) stays a
    // non-blocking "incomplete" report.
    const parsed = parse(
      "username,email,first_name,section\n,,Nobody,Sec A\n,,,Sec B\n",
    )
    expect(parsed.rows).toHaveLength(0)
    expect(parsed.unlinked).toEqual([
      { line: 2, first_name: "Nobody", last_name: "", section: "Sec A" },
    ])
    expect(parsed.dropped).toEqual([{ line: 3, reason: "incomplete" }])
  })

  it("reports BOTH unusable cells rather than blaming just one", () => {
    // The old behavior picked a single cell to blame. Reporting both is what lets
    // one editing pass fix the row.
    const parsed = parse("username,email\n-bad-,n/a\n")
    expect(parsed.dropped).toEqual([
      { line: 2, reason: "bad-username", value: "-bad-" },
      { line: 2, reason: "bad-email", value: "n/a" },
    ])
  })

  it("reports an unusable cell even when a sibling cell resolves", () => {
    // The shifted-column case: `n/a` in the email column beside a valid username.
    // Before this was reported the row imported silently AND stored `n/a` as the
    // student's contact address.
    const parsed = parse("username,email\nada,n/a\n")
    expect(parsed.dropped).toEqual([
      { line: 2, reason: "bad-email", value: "n/a" },
    ])
    expect(parsed.rows[0]?.identity).toEqual({ username: "ada" })
    // And the unusable value never rides into roster.csv as metadata.
    expect(parsed.rows[0]?.email).toBe("")
  })

  it("drops an unreadable bare line as bad-value, naming neither shape", () => {
    // Under the default the line could have been a handle or an address and was
    // neither, so the message can't claim to know which the teacher meant.
    const parsed = parse("ada\nJohn Smith\n")
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.dropped).toEqual([
      { line: 2, reason: "bad-value", value: "John Smith" },
    ])
  })

  it("blames the handle shape for a bad bare line under the username override", () => {
    const parsed = parse("ada\nJohn Smith\n", "username-list")
    expect(parsed.dropped).toEqual([
      { line: 2, reason: "bad-username", value: "John Smith" },
    ])
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

  it("reads a headed CSV as a flat list under the username-list override", () => {
    // The override is an assertion about EVERY line, so a header row is data too.
    // Reading it columnar would silently ignore what the teacher asserted.
    const parsed = parse("username\nada\nbob\n", "username-list")
    expect(parsed.rows.map((r) => r.identity)).toEqual([
      { username: "ada" },
      { username: "bob" },
    ])
    // `username` is a recognized column name, so it's treated as the caption it is.
    expect(parsed.dropped).toEqual([])
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

// The email-list override, previously a separate line-oriented parser. Selecting
// it asserts every line is an address, so nothing is read columnar and no line is
// re-read as a handle.
describe("parseRosterImportFile: email-list override", () => {
  const emails = (text: string) =>
    parse(text, "email-list").rows.map((r) => r.identity.email)

  it("reads one address per line, trimming and stripping mailto:", () => {
    const text = "  ada@uni.edu  \nmailto:bob@example.com\nMAILTO:cara@x.io\n"
    expect(emails(text)).toEqual([
      "ada@uni.edu",
      "bob@example.com",
      "cara@x.io",
    ])
  })

  it("does NOT read a header row as headers", () => {
    // The whole point of the short-circuit: Papa would consume line 1 as a header
    // and take the columnar branch on a file the teacher told us was a flat list.
    expect(emails("email\nada@uni.edu\n")).toEqual(["ada@uni.edu"])
  })

  it("blocks a handle instead of silently importing it as an email row", () => {
    const parsed = parse("ada@uni.edu\noctocat\n", "email-list")
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.dropped).toEqual([
      { line: 2, reason: "bad-email", value: "octocat" },
    ])
  })

  it("reports each invalid line with its number and raw value", () => {
    const parsed = parse(
      "ada@uni.edu\nnot-an-email\n@handle\nbob@x\n",
      "email-list",
    )
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.dropped).toEqual([
      { line: 2, reason: "bad-email", value: "not-an-email" },
      { line: 3, reason: "bad-email", value: "@handle" },
      { line: 4, reason: "bad-email", value: "bob@x" },
    ])
  })

  it("skips blank lines silently rather than reporting them", () => {
    const parsed = parse("ada@uni.edu\n\n   \nbob@example.com\n", "email-list")
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.dropped).toEqual([])
  })

  it("counts a leading blank line when reporting a bad one", () => {
    expect(parse("\nada@uni.edu\n\nnope\n", "email-list").dropped).toEqual([
      { line: 4, reason: "bad-email", value: "nope" },
    ])
  })

  it("ignores a leading BOM rather than corrupting the first address", () => {
    expect(parse("\uFEFFada@uni.edu\n", "email-list").rows).toEqual([
      { line: 1, identity: { email: "ada@uni.edu" }, email: "ada@uni.edu" },
    ])
  })

  it("normalizes casing so one person can't be invited twice", () => {
    // identityKey is derived from the address, so keeping the file's casing would
    // make these three separate identities and send three invitations.
    expect(emails("Ada@Uni.edu\nada@uni.edu\nADA@UNI.EDU\n")).toEqual([
      "ada@uni.edu",
      "ada@uni.edu",
      "ada@uni.edu",
    ])
  })

  it("returns nothing for empty or whitespace-only input", () => {
    expect(parse("", "email-list")).toEqual({
      rows: [],
      dropped: [],
      unlinked: [],
    })
    expect(parse("  \n \n", "email-list")).toEqual({
      rows: [],
      dropped: [],
      unlinked: [],
    })
  })
})

describe("ROSTER_TEMPLATE_CSV", () => {
  it("parses cleanly under the default format, covering every identity shape", () => {
    const result = parse(ROSTER_TEMPLATE_CSV)
    expect(result.dropped).toEqual([])
    expect(result.unlinked).toEqual([])
    const identities = result.rows.map((r) => r.identity)
    expect(identities).toEqual([
      { username: "student1", email: "student1@example.com" },
      { username: "student2" },
      { email: "student3@example.net" },
      { username: "student4" },
      { username: "student5", email: "student5@example.edu" },
    ])
    // Reserved example domains only — a template address must never be
    // deliverable.
    for (const row of result.rows) {
      if (row.email) expect(row.email).toMatch(/@example\.(com|net|edu)$/)
    }
    // At least one row leaves section blank, so the template itself shows the
    // column is optional.
    expect(result.rows.some((r) => r.section === "")).toBe(true)
  })
})
