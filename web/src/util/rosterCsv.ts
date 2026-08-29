import Papa from "papaparse"

import {
  escapeCsvFormulaInjection,
  unescapeCsvFormulaInjection,
} from "@/util/csv"

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
  "status",
] as const
type StudentCsvField = (typeof STUDENT_CSV_FIELDS)[number]

export type StudentCsvRow = Record<StudentCsvField, string>

// The `status` value marking a teacher-kept row with no GitHub identity (no
// username, no usable github_id). Such a row is never reaped by the sync's
// dead-row removal and never removed by an invite cancel — it leaves the state
// only by gaining an identity (a claim clears the marker) or by an explicit
// teacher delete. Mirrors the CLI's configrepo.RosterStatusUnlinked with no
// compile-time link; the shared row cases pin the keep-rule half.
export const ROSTER_STATUS_UNLINKED = "unlinked"

// The one reading of the marker cell, shared by every consumer (the reap and
// cancel exclusions, the roster view's unlinked pass, the link/remove
// actions). Unknown values read as unmarked — additive evolution.
export function hasUnlinkedMarker(status: string | null | undefined): boolean {
  return (status ?? "").trim() === ROSTER_STATUS_UNLINKED
}

// The keep-rule: which parsed rows survive a read (and a write). A row must
// identify a student (username, github_id, or email) or at least DESCRIBE one
// (a name, or the explicit `status` marker) — a row with only section/role
// noise, or nothing at all, is dropped. Callers pass normalizeStudentRow
// output, so every cell is already trimmed. Mirrors the CLI's recordToRow
// rule; shared cases: cli/shared/testdata/roster_row_cases.json.
function isKeptRosterRow(row: StudentCsvRow): boolean {
  return Boolean(
    row.username ||
    row.github_id ||
    row.email ||
    row.first_name ||
    row.last_name ||
    row.status,
  )
}

export function normalizeStudentRow(
  row: Partial<Record<StudentCsvField, unknown>>,
): StudentCsvRow {
  const cell = (value: unknown) =>
    unescapeCsvFormulaInjection(String(value ?? "").trim())
  return {
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
    // Lifecycle marker ("unlinked" or ""); unknown values are preserved
    // verbatim and treated as "" by logic — additive evolution. A pre-status
    // file has no status column, so this coerces to "".
    status: cell(row.status),
  }
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
// line 1) and a human-readable message. Surfaced to the teacher so a
// malformed roster names exactly what's wrong and where, rather than failing
// silently or with an opaque blob.
export type RosterCsvProblem = {
  line: number
  message: string
}

export type ParsedRosterCsv = {
  rows: StudentCsvRow[]
  problems: RosterCsvProblem[]
}

// Parse roster.csv into normalized rows plus a structured list of problems.
// Never throws on a malformed file — the caller decides whether to refuse
// (writes) or surface a banner (the view). `parseStudentsCsv` is the throwing
// wrapper for write paths.
export function parseRosterCsv(csv: string): ParsedRosterCsv {
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    delimiter: ",",
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
  })

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

  const problems: RosterCsvProblem[] = parsed.errors
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
    }))

  const rows = parsed.data
    .map((row) => normalizeStudentRow(row))
    .filter(isKeptRosterRow)

  return { rows, problems }
}

// The view uses the structured `problems` instead of this flattened form.
export function formatRosterProblems(problems: RosterCsvProblem[]): string {
  return problems.map((p) => `line ${p.line}: ${p.message}`).join("; ")
}

export function parseStudentsCsv(csv: string): StudentCsvRow[] {
  const { rows, problems } = parseRosterCsv(csv)
  if (problems.length > 0) {
    throw new Error(
      `Could not parse roster.csv: ${formatRosterProblems(problems)}`,
    )
  }
  return rows
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
  "status",
] as const

export function stringifyStudentsCsv(rows: StudentCsvRow[]) {
  const normalizedRows = rows
    .map((row) => normalizeStudentRow(row))
    .filter(isKeptRosterRow)
    .map((row) => {
      const guarded = { ...row }
      for (const field of FORMULA_GUARDED_FIELDS) {
        guarded[field] = escapeCsvFormulaInjection(guarded[field])
      }
      return guarded
    })

  // Papa.unparse omits the header for an empty array, so an emptied roster
  // would commit a header-less file the CLI/skeleton readers reject. Write the
  // canonical header explicitly instead (keep in lockstep with STUDENT_CSV_FIELDS).
  if (normalizedRows.length === 0) {
    return STUDENT_CSV_FIELDS.join(",") + "\n"
  }

  return (
    Papa.unparse(normalizedRows, {
      columns: [...STUDENT_CSV_FIELDS],
      delimiter: ",",
      header: true,
      newline: "\n",
    }) + "\n"
  )
}
