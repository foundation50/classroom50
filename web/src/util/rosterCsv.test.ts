import { describe, expect, it } from "vitest"
import {
  FORMULA_GUARDED_FIELDS,
  STUDENT_CSV_FIELDS,
  formatRosterProblems,
  normalizeStudentRow,
  parseRosterCsv,
  parseStudentsCsv,
  splitName,
  stringifyStudentsCsv,
  type StudentCsvRow,
} from "./rosterCsv"
import { FORMULA_LEAD_SOURCE } from "./csv"

// Characterization tests for the roster.csv parse/serialize layer that every
// roster import, sync, and write goes through.

const HEADER = STUDENT_CSV_FIELDS.join(",")

// The guard is only useful if both writers defang the same columns on the same
// triggers: a cell one side guards and the other doesn't un-defang keeps the
// quote as data. Pinning the source-of-truth constants (mirroring the header
// lockstep in students.test.ts) fails loudly on a one-sided change instead of
// leaving both suites green.
describe("csv formula-guard lockstep (web leg)", () => {
  it("guards every canonical column except github_id", () => {
    expect([...FORMULA_GUARDED_FIELDS]).toEqual(
      STUDENT_CSV_FIELDS.filter((f) => f !== "github_id"),
    )
  })

  // Mirrors isFormulaTrigger in cli/gh-teacher/internal/configrepo/students_csv.go.
  it("matches the Go trigger set verbatim", () => {
    expect(FORMULA_LEAD_SOURCE).toBe("^[=+\\-@\\t\\r]")
  })
})

const row = (over: Partial<StudentCsvRow> = {}): StudentCsvRow =>
  normalizeStudentRow({
    username: "octocat",
    first_name: "Grace",
    last_name: "Hopper",
    email: "grace@example.com",
    section: "Section A",
    github_id: "583231",
    role: "student",
    ...over,
  })

describe("normalizeStudentRow", () => {
  it("trims every column and defaults missing ones to empty string", () => {
    expect(
      normalizeStudentRow({ username: "  octocat  ", first_name: " Grace " }),
    ).toEqual({
      username: "octocat",
      first_name: "Grace",
      last_name: "",
      email: "",
      section: "",
      github_id: "",
      role: "",
    })
  })

  it("coerces non-string and null values (a pre-role file has no role column)", () => {
    expect(
      normalizeStudentRow({
        username: 123,
        github_id: 583231,
        first_name: null,
        role: undefined,
      }),
    ).toMatchObject({
      username: "123",
      github_id: "583231",
      first_name: "",
      role: "",
    })
  })

  it("does not lowercase or otherwise rewrite values", () => {
    expect(normalizeStudentRow({ email: "  Grace@Example.IO  " }).email).toBe(
      "Grace@Example.IO",
    )
  })
})

describe("splitName", () => {
  it("takes the first token as first_name and the rest as last_name", () => {
    expect(splitName("Grace Hopper")).toEqual({
      first_name: "Grace",
      last_name: "Hopper",
    })
    expect(splitName("Mary Ann Evans")).toEqual({
      first_name: "Mary",
      last_name: "Ann Evans",
    })
  })

  it("collapses irregular whitespace", () => {
    expect(splitName("  Grace   Hopper  ")).toEqual({
      first_name: "Grace",
      last_name: "Hopper",
    })
  })

  it("handles a single token, empty input, and a null display name", () => {
    expect(splitName("Grace")).toEqual({ first_name: "Grace", last_name: "" })
    expect(splitName("")).toEqual({ first_name: "", last_name: "" })
    expect(splitName("   ")).toEqual({ first_name: "", last_name: "" })
    expect(splitName(null)).toEqual({ first_name: "", last_name: "" })
  })
})

describe("parseRosterCsv", () => {
  it("parses a well-formed file with no problems", () => {
    const csv = `${HEADER}\nocto,Grace,Hopper,g@x.io,Section A,583231,student\n`
    expect(parseRosterCsv(csv)).toEqual({
      rows: [
        {
          username: "octo",
          first_name: "Grace",
          last_name: "Hopper",
          email: "g@x.io",
          section: "Section A",
          github_id: "583231",
          role: "student",
        },
      ],
      problems: [],
    })
  })

  it("returns no rows and no problems for an empty or header-only file", () => {
    expect(parseRosterCsv("")).toEqual({ rows: [], problems: [] })
    expect(parseRosterCsv(`${HEADER}\n`)).toEqual({ rows: [], problems: [] })
  })

  it("honors quoted fields containing commas and trims padded headers", () => {
    const csv =
      " username , first_name ,last_name,email,section,github_id,role\n" +
      'octo,"Hopper, Grace",X,g@x.io,"Section, A",1,student\n'
    const { rows, problems } = parseRosterCsv(csv)
    expect(problems).toEqual([])
    expect(rows[0]).toMatchObject({
      username: "octo",
      first_name: "Hopper, Grace",
      section: "Section, A",
    })
  })

  it("skips blank lines and rows carrying no identity column", () => {
    const csv = `${HEADER}\n\n,,,,,,\nocto,A,B,,,,\n\n`
    const { rows, problems } = parseRosterCsv(csv)
    expect(problems).toEqual([])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ username: "octo" })
  })

  it("keeps a row whose only identity is an email or a github_id", () => {
    const csv = `${HEADER}\n,,,only@x.io,,,\n,,,,,583231,\n`
    const { rows } = parseRosterCsv(csv)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ username: "", email: "only@x.io" })
    expect(rows[1]).toMatchObject({ username: "", github_id: "583231" })
  })

  // Deliberate: the benign "trailing role/github_id omitted" case, so a sync
  // must not abort on it.
  it("tolerates a row short by exactly one column (dropped trailing field)", () => {
    const csv = `${HEADER}\nocto,Grace,Hopper,g@x.io,Section A,583231\n`
    const { rows, problems } = parseRosterCsv(csv)
    expect(problems).toEqual([])
    expect(rows[0]).toMatchObject({ github_id: "583231", role: "" })
  })

  // The cost of that tolerance: width can't tell a middle drop from a trailing
  // one, so this corruption is accepted rather than detectable.
  it("silently left-shifts a row short by one because a middle cell was dropped", () => {
    const csv = `${HEADER}\nocto,Grace,Hopper,Section A,583231,student\n`
    const { rows, problems } = parseRosterCsv(csv)
    expect(problems).toEqual([])
    expect(rows[0]).toMatchObject({
      email: "Section A",
      section: "583231",
      github_id: "student",
      role: "",
    })
  })

  it("reports a row short by two or more columns rather than dropping it silently", () => {
    const csv = `${HEADER}\nocto,Grace,Hopper,g@x.io,Section A\n`
    const { rows, problems } = parseRosterCsv(csv)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ line: 2 })
    expect(problems[0].message).toMatch(/too few fields/i)
    // The row is still returned; the caller decides whether to refuse.
    expect(rows).toHaveLength(1)
  })

  it("reports a row with too many fields", () => {
    const csv = `${HEADER}\nocto,Grace,Hopper,g@x.io,Section A,583231,student,EXTRA\n`
    const { problems } = parseRosterCsv(csv)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ line: 2 })
    expect(problems[0].message).toMatch(/too many fields/i)
  })

  // One short-by-one row alone is benign, but the tolerance is all-or-nothing:
  // once any row is short by 2+, no short row is excused, so the benign row is
  // reported too. Pinned because it is the non-obvious half of the rule.
  it("stops excusing short-by-one rows once another row is short by two", () => {
    const csv =
      `${HEADER}\n` +
      "octo,Grace,Hopper,g@x.io,Section A,583231\n" +
      "mona,M,L,m@x.io,Section B\n"
    const { problems } = parseRosterCsv(csv)
    expect(problems.map((p) => p.line)).toEqual([2, 3])
  })

  it("numbers problem lines against the file, counting the header as line 1", () => {
    const csv =
      `${HEADER}\n` +
      "ok,A,B,a@x.io,S,1,student\n" +
      "bad,A,B,b@x.io,S,2,student,EXTRA\n"
    const { problems } = parseRosterCsv(csv)
    expect(problems).toHaveLength(1)
    expect(problems[0].line).toBe(3)
  })
})

describe("formatRosterProblems", () => {
  it("renders each problem with its line number, joined by semicolons", () => {
    expect(
      formatRosterProblems([
        { line: 2, message: "Too many fields" },
        { line: 5, message: "Too few fields" },
      ]),
    ).toBe("line 2: Too many fields; line 5: Too few fields")
  })

  it("renders an empty list as an empty string", () => {
    expect(formatRosterProblems([])).toBe("")
  })
})

describe("parseStudentsCsv", () => {
  it("returns rows for a well-formed file", () => {
    const csv = `${HEADER}\nocto,Grace,Hopper,g@x.io,Section A,583231,student\n`
    expect(parseStudentsCsv(csv)).toHaveLength(1)
  })

  it("throws with the formatted problems when the file is malformed", () => {
    const csv = `${HEADER}\nocto,Grace,Hopper,g@x.io,Section A,583231,student,EXTRA\n`
    expect(() => parseStudentsCsv(csv)).toThrow(/Could not parse roster\.csv/)
    expect(() => parseStudentsCsv(csv)).toThrow(/line 2:/)
  })

  it("does not throw on the tolerated short-by-one row", () => {
    const csv = `${HEADER}\nocto,Grace,Hopper,g@x.io,Section A,583231\n`
    expect(() => parseStudentsCsv(csv)).not.toThrow()
  })
})

describe("stringifyStudentsCsv", () => {
  it("writes the canonical header and one line per row", () => {
    const csv = stringifyStudentsCsv([row({ username: "octo" })])
    const [header, first] = csv.split("\n")
    expect(header).toBe(HEADER)
    expect(first).toBe(
      "octo,Grace,Hopper,grace@example.com,Section A,583231,student",
    )
    expect(csv.endsWith("\n")).toBe(true)
  })

  // Papa.unparse omits the header for an empty array, which would commit a
  // header-less file the CLI/skeleton readers reject.
  it("still writes the header for an emptied roster", () => {
    expect(stringifyStudentsCsv([])).toBe(`${HEADER}\n`)
  })

  it("drops rows with no identity column", () => {
    const csv = stringifyStudentsCsv([
      row({ username: "keep" }),
      normalizeStudentRow({ first_name: "no identity" }),
    ])
    expect(csv.trim().split("\n")).toHaveLength(2)
    expect(csv).toContain("keep")
    expect(csv).not.toContain("no identity")
  })

  it("round-trips rows through parse without changing them", () => {
    const rows = [
      row({ username: "octo", github_id: "1" }),
      row({ username: "mona", github_id: "2", role: "" }),
    ]
    expect(parseStudentsCsv(stringifyStudentsCsv(rows))).toEqual(rows)
  })

  it("round-trips values containing commas and quotes", () => {
    const rows = [
      row({ first_name: 'Grace "Amazing"', section: "Section A, B" }),
    ]
    expect(parseStudentsCsv(stringifyStudentsCsv(rows))).toEqual(rows)
  })

  // Every column except github_id is defanged, matching the Go writer's set. The
  // guard quote lives in the STORED value, so the read path strips it back off —
  // a teacher never sees the escaping we added.
  it("defangs every column but github_id, and undefangs on read", () => {
    const row = normalizeStudentRow({
      username: "user",
      first_name: "=1+1",
      last_name: "-x",
      section: "@SUM(1)",
      email: "=a@evil.com",
      github_id: "583231",
      role: "=student",
    })
    const csv = stringifyStudentsCsv([row])
    const data = csv.split("\n")[1]
    expect(data).toContain("'=1+1")
    expect(data).toContain("'-x")
    expect(data).toContain("'@SUM(1)")
    expect(data).toContain("'=a@evil.com")
    expect(data).toContain("'=student")
    expect(data).toContain(",583231,")
    expect(parseStudentsCsv(csv)[0]).toEqual(row)
  })

  it("defangs a formula-leading username", () => {
    const csv = stringifyStudentsCsv([
      normalizeStudentRow({ username: "=cmd|'/c calc'!A1", email: "a@x.io" }),
    ])
    expect(csv.split("\n")[1]).toMatch(/^'=cmd/)
  })

  // A user-typed apostrophe is not our escaping, so it must survive the read.
  it("leaves a leading apostrophe that isn't a formula guard alone", () => {
    const row = normalizeStudentRow({ username: "user", last_name: "'tis" })
    expect(parseStudentsCsv(stringifyStudentsCsv([row]))[0].last_name).toBe(
      "'tis",
    )
  })

  // github_id round-trips byte-exact, valid or not: the identity join compares the
  // raw string, and the serializer must not rewrite a cell the teacher owns (a
  // roster write touches EVERY row, so silently "fixing" one would corrupt the
  // rest). A malformed value is refused at the point of use instead.
  it("round-trips github_id byte-exact, including an unusable value", () => {
    const csv = stringifyStudentsCsv([
      normalizeStudentRow({ username: "valid", github_id: "583231" }),
      normalizeStudentRow({ username: "bad", github_id: "1e3" }),
      normalizeStudentRow({ username: "injected", github_id: "=99" }),
    ])
    expect(parseStudentsCsv(csv).map((r) => r.github_id)).toEqual([
      "583231",
      "1e3",
      "=99",
    ])
  })

  // Regression: blanking an unusable id inside the serializer emitted `,,,,,,`
  // for a row whose ONLY identity was that id, deleting the student on re-read
  // (and the blank-username line fails the Go reader outright).
  it("keeps a row whose only identity is an unusable github_id", () => {
    const csv = stringifyStudentsCsv([
      normalizeStudentRow({ username: "keep", github_id: "583231" }),
      normalizeStudentRow({ github_id: "1e3" }),
    ])
    expect(csv).not.toContain("\n,,,,,,")
    expect(parseStudentsCsv(csv)).toHaveLength(2)
  })

  it("is idempotent for an already-guarded value", () => {
    const once = stringifyStudentsCsv([
      normalizeStudentRow({ username: "user", first_name: "=1+1" }),
    ])
    const twice = stringifyStudentsCsv(parseStudentsCsv(once))
    expect(twice).toBe(once)
  })
})
