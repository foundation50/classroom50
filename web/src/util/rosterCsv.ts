import Papa from "papaparse"

import {
  escapeCsvFormulaInjection,
  hasCsvFormulaLead,
  trimCsvHeader,
  unescapeCsvFormulaInjection,
} from "@/util/csv"
import {
  describeLocalizedMessage,
  type LocalizedMessage,
} from "@/types/localizedMessage"

// The pure roster.csv parse/serialize layer, lifted out of the mutation module
// so problem detection lives next to the other pure roster helpers (teamRoster)
// and carries no GitHubClient dependency. `domain/students` re-exports
// every symbol here, so existing importers are unaffected.

export const STUDENT_CSV_FIELDS = [
  "username",
  "first_name",
  "last_name",
  "email",
  "section",
  "github_id",
  "role",
] as const
type StudentCsvField = (typeof STUDENT_CSV_FIELDS)[number]

// The reserved columns that can identify a student, in the precedence order the
// import resolves them (a github_id addresses an immutable account; a username
// is what an SIS export produces; an email routes to an invitation). A stored
// roster or an upload must carry at least one; every other reserved column is
// optional on read because every writer emits the full header. Mirrors the
// CLI's identityColumns.
export const IDENTITY_CSV_FIELDS = ["github_id", "username", "email"] as const

// Cells of the non-canonical header columns, wherever they sit in the header,
// keyed by the trimmed header name. A teacher may widen roster.csv by hand or
// via the CLI, and every read-modify-write here must round-trip those cells like
// the CLI's RosterRow.Extra does. Optional so a row built from the seven
// canonical fields still type-checks; an absent key writes as "".
export type StudentCsvRow = Record<StudentCsvField, string> & {
  extra?: Record<string, string>
}

function isCanonicalColumn(name: string): name is StudentCsvField {
  return (STUDENT_CSV_FIELDS as readonly string[]).includes(name)
}

// The keep-rule: which parsed rows survive a read (and a write). A row must
// identify a student (username, github_id, or email) or at least DESCRIBE one
// (a name) — a row with only section/role noise, or nothing at all, is
// dropped. Callers pass normalizeStudentRow output, so every cell is already
// trimmed. Mirrors the CLI's recordToRow rule (extra cells never count there
// either); shared cases: cli/shared/testdata/roster_row_cases.json.
function isKeptRosterRow(row: StudentCsvRow): boolean {
  return Boolean(
    row.username ||
    row.github_id ||
    row.email ||
    row.first_name ||
    row.last_name,
  )
}

export function normalizeStudentRow(
  row: Partial<Record<StudentCsvField, unknown>> & {
    extra?: Record<string, unknown>
  },
): StudentCsvRow {
  const cell = (value: unknown) =>
    unescapeCsvFormulaInjection(String(value ?? "").trim())
  const normalized: StudentCsvRow = {
    username: cell(row.username),
    first_name: cell(row.first_name),
    last_name: cell(row.last_name),
    email: cell(row.email),
    section: cell(row.section),
    // Not undefanged: github_id is never guarded on write, so a leading quote
    // here is the teacher's own (malformed) value, not our escaping.
    github_id: String(row.github_id ?? "").trim(),
    // Best-effort recorded metadata (teacher/ta/student, or ""), refreshed
    // from the classroom's GitHub teams on sync. A pre-role file has no role
    // column, so this coerces to "".
    role: cell(row.role),
  }
  if (row.extra) {
    // Undefanged but NOT trimmed: the CLI's recordToRow only undefangs an extra
    // cell, and these columns belong to the teacher, so they round-trip as-is.
    normalized.extra = Object.fromEntries(
      Object.entries(row.extra).map(([name, value]) => [
        name,
        unescapeCsvFormulaInjection(String(value ?? "")),
      ]),
    )
  }
  return normalized
}

// Split a full name: first token is first_name, the remainder is last_name.
// Accepts null since GitHub's display name may be null. The single canonical
// implementation; re-exported from util/roster as splitName for UI callers.
export function splitName(name: string | null): {
  first_name: string
  last_name: string
} {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean)
  return { first_name: parts.at(0) ?? "", last_name: parts.slice(1).join(" ") }
}

// A structured problem in a roster.csv file: a 1-based file line (header is
// line 1) and a message. Surfaced to the teacher so a malformed roster names
// exactly what's wrong and where, rather than failing silently or with an
// opaque blob. Our own problems carry a deferred `{ key, params }` for the view
// to translate; a Papa parse error keeps its library message as a string.
export type RosterCsvProblem = {
  line: number
  message: string | LocalizedMessage
}

export type ParsedRosterCsv = {
  rows: StudentCsvRow[]
  problems: RosterCsvProblem[]
  // The header a rewrite must emit: the canonical columns, then every extra
  // column in file order. Hand it back to stringifyStudentsCsv.
  columns: string[]
}

// Parse roster.csv into normalized rows plus a structured list of problems.
// Never throws on a malformed file — the caller decides whether to refuse
// (writes) or surface a banner (the view). `parseRosterForRewrite` is the
// throwing wrapper for write paths.
export function parseRosterCsv(csv: string): ParsedRosterCsv {
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    delimiter: ",",
    skipEmptyLines: "greedy",
    transformHeader: trimCsvHeader,
  })
  const fields = parsed.meta.fields ?? []
  const extraColumns = fields.filter((name) => !isCanonicalColumn(name))

  // A `TooFewFields` row is tolerated ONLY when it is short by exactly one
  // column — the ambiguous-but-benign "trailing `github_id` omitted" case:
  // `octocat,Grace,Hopper,,Section A` (5 fields) maps cleanly under
  // `header: true` (the missing trailing field is `undefined`, coerced to "" by
  // normalizeStudentRow), so a sync/read shouldn't abort on a roster merely
  // missing trailing commas. A row short by TWO or more can't be explained by a
  // single dropped trailing field, and since Papa maps values POSITIONALLY it
  // would silently shift every value into the wrong column (corrupting the
  // identity/email join with no error) — exactly as untrustworthy as a
  // `TooManyFields` row, so it stays a problem. (A row short by exactly one
  // where a MIDDLE cell was dropped is positionally indistinguishable from a
  // dropped trailing field, so it is unavoidably read as the latter.)
  // Only re-parse (tooFewFieldsAreTrailingOnly runs a second full parse) when a
  // TooFewFields error is actually present — the flag is never read otherwise.
  const shortRowsWithinTolerance =
    parsed.errors.some((error) => error.code === "TooFewFields") &&
    tooFewFieldsAreTrailingOnly(
      csv,
      parsed.meta.fields?.length ?? STUDENT_CSV_FIELDS.length,
    )

  const problems: RosterCsvProblem[] = [
    ...headerProblems(fields, parsed.meta.renamedHeaders),
    ...parsed.errors
      .filter(
        (error) =>
          error.type !== "Delimiter" &&
          !(error.code === "TooFewFields" && shortRowsWithinTolerance),
      )
      // Papa's `row` is the 0-based DATA row; the file line is that + 2 (header is
      // line 1). Fall back to line 1 for a file-level error with no row.
      .map((error) => ({
        line: typeof error.row === "number" ? error.row + 2 : 1,
        message: error.message,
      })),
  ]

  const rows = parsed.data
    .map((row) =>
      normalizeStudentRow(
        extraColumns.length === 0
          ? row
          : {
              ...row,
              extra: Object.fromEntries(
                extraColumns.map((name) => [name, row[name] ?? ""]),
              ),
            },
      ),
    )
    .filter(isKeptRosterRow)

  return { rows, problems, columns: [...STUDENT_CSV_FIELDS, ...extraColumns] }
}

// Header-level problems, mirroring the CLI's parseRosterLayout rejections so
// neither tool writes a file the other refuses: no identity column, a duplicate
// name (Papa renames it to `name_1` and records the original in
// renamedHeaders), and an extra name leading with a formula trigger (header
// names are written verbatim). Header names arrive trimmed (transformHeader),
// as the CLI trims too.
function headerProblems(
  fields: readonly string[],
  renamedHeaders: Record<string, string> | undefined,
): RosterCsvProblem[] {
  if (fields.length === 0) {
    return [
      {
        line: 1,
        message: {
          key: "students.rosterProblemEmptyFile",
          params: { header: STUDENT_CSV_FIELDS.join(",") },
        },
      },
    ]
  }
  const problems: RosterCsvProblem[] = []
  const headerProblem = (key: string, name: string) =>
    problems.push({ line: 1, message: { key, params: { name } } })
  if (!IDENTITY_CSV_FIELDS.some((name) => fields.includes(name))) {
    problems.push({
      line: 1,
      message: { key: "students.rosterProblemNoIdentityColumn" },
    })
  }
  for (const [, original] of Object.entries(renamedHeaders ?? {})) {
    headerProblem(
      isCanonicalColumn(original)
        ? "students.rosterProblemReservedColumn"
        : "students.rosterProblemDuplicateColumn",
      original,
    )
  }
  for (const name of fields) {
    if (!isCanonicalColumn(name) && hasCsvFormulaLead(name)) {
      headerProblem("students.rosterProblemFormulaColumn", name)
    }
  }
  return problems
}

// Diagnostic form for thrown errors and logs; the view translates the
// structured `problems` itself.
export function formatRosterProblems(problems: RosterCsvProblem[]): string {
  return problems
    .map(
      (p) =>
        `line ${p.line}: ${
          typeof p.message === "string"
            ? p.message
            : describeLocalizedMessage(p.message)
        }`,
    )
    .join("; ")
}

// The strict read every roster rewrite starts from. Throws on any problem: a
// positional re-serialize of a malformed file would corrupt the bad row.
export function parseRosterForRewrite(csv: string): {
  rows: StudentCsvRow[]
  columns: string[]
} {
  const { rows, problems, columns } = parseRosterCsv(csv)
  if (problems.length > 0) {
    throw new Error(
      `Could not parse roster.csv: ${formatRosterProblems(problems)}`,
    )
  }
  return { rows, columns }
}

export function parseStudentsCsv(csv: string): StudentCsvRow[] {
  return parseRosterForRewrite(csv).rows
}

// True when EVERY short data row is short by exactly one column. Re-parses
// without `header` to read raw row widths (the header-keyed `data` hides how
// many physical columns are missing). Width can't tell a dropped trailing cell
// from a dropped middle one, so both are excused and a middle drop left-shifts
// silently. A row short by 2+ (or a header we couldn't count) is fatal.
function tooFewFieldsAreTrailingOnly(
  csv: string,
  headerWidth: number,
): boolean {
  if (headerWidth <= 0) return false
  const raw = Papa.parse<string[]>(csv, {
    delimiter: ",",
    skipEmptyLines: "greedy",
  })
  // rows[0] is the header; a short DATA row is benign only at width-1.
  return raw.data
    .slice(1)
    .every(
      (row) => row.length === headerWidth || row.length === headerWidth - 1,
    )
}

// Which student fields to defang: every column except github_id. Free text is the
// obvious case, but email matters too — it's a member-controlled GitHub profile
// field written verbatim by syncRosterFromTeam/bulk import, so a formula-leading
// verified email (e.g. `=1+1@evil.com`) would otherwise reach roster.csv and
// execute on open. Must stay in lockstep with the Go writer's set (a drift test
// pins both).
//
// NOTE: this writes the leading quote into the STORED value, so parseRosterCsv
// strips it back off on read (mirroring the CLI's undefang) and matching keys on
// normalized values, so guarding a cell doesn't affect the joins.
//
// github_id must stay out: it has to round-trip byte-exact for the identity join,
// and the Go reader parses that column as a number, so a defang quote there would
// fail the whole roster rather than one cell.
export const FORMULA_GUARDED_FIELDS = [
  "username",
  "first_name",
  "last_name",
  "email",
  "section",
  "role",
] as const

const GUARDED_FIELD_SET: ReadonlySet<string> = new Set(FORMULA_GUARDED_FIELDS)

// Serialize rows as roster.csv under the header a parse returned (`columns`),
// so the teacher's extra columns survive a rewrite. Required rather than
// defaulted: a writer that forgot it would still pass on a populated roster and
// only drop the extra columns on an emptied one. Extra cells are defanged like
// the free-text canonical fields, matching the CLI's EncodeRoster, and a row
// missing an extra key writes "".
export function stringifyStudentsCsv(
  rows: StudentCsvRow[],
  columns: readonly string[],
) {
  const normalizedRows = rows
    .map((row) => normalizeStudentRow(row))
    .filter(isKeptRosterRow)
  const extraColumns = columns.filter((name) => !isCanonicalColumn(name))
  const header = [...STUDENT_CSV_FIELDS, ...extraColumns]

  const records = normalizedRows.map((row) => [
    ...STUDENT_CSV_FIELDS.map((field) =>
      GUARDED_FIELD_SET.has(field)
        ? escapeCsvFormulaInjection(row[field])
        : row[field],
    ),
    ...extraColumns.map((name) =>
      escapeCsvFormulaInjection(row.extra?.[name] ?? ""),
    ),
  ])

  // The `{ fields, data }` form writes the header even for zero rows, so an
  // emptied roster keeps its header (and its extra columns) rather than
  // committing a header-less file the CLI/skeleton readers reject. Papa ends
  // only that header-only output with a newline, hence the conditional.
  const csv = Papa.unparse(
    { fields: header, data: records },
    { delimiter: ",", header: true, newline: "\n" },
  )
  return csv.endsWith("\n") ? csv : csv + "\n"
}
