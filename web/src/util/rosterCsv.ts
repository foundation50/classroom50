import Papa from "papaparse"

import { escapeCsvFormulaInjection } from "@/util/csv"

// The pure roster.csv parse/serialize layer, lifted out of the mutation module
// so problem detection lives next to the other pure roster helpers (teamRoster)
// and carries no GitHubClient dependency. `api/mutations/students` re-exports
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

export type StudentCsvRow = Record<StudentCsvField, string>

export function normalizeStudentRow(
  row: Partial<Record<StudentCsvField, unknown>>,
): StudentCsvRow {
  return {
    username: String(row.username ?? "").trim(),
    first_name: String(row.first_name ?? "").trim(),
    last_name: String(row.last_name ?? "").trim(),
    email: String(row.email ?? "").trim(),
    section: String(row.section ?? "").trim(),
    github_id: String(row.github_id ?? "").trim(),
    // Best-effort recorded metadata (instructor/ta/student, or ""), refreshed
    // from the classroom's GitHub teams on sync. A pre-role file has no role
    // column, so this coerces to "".
    role: String(row.role ?? "").trim(),
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
// line 1) and a human-readable message. Surfaced to the instructor so a
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
    .filter((row) => row.username || row.github_id || row.email)

  return { rows, problems }
}

// Format roster problems into a single-line message for the throwing wrapper
// and logs. The view uses the structured `problems` instead.
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

// True when EVERY short data row is short by exactly one column, i.e. only the
// trailing field was dropped. Re-parses without `header` to read raw row widths
// (the header-keyed `data` hides which physical column is missing), so a row
// dropping a middle cell — which Papa would silently left-shift — is NOT treated
// as benign. A row that's short by 2+ (or a header we couldn't count) is fatal.
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

// Which student fields to defang. Applied to name/section free text AND email —
// email is a member-controlled GitHub profile field written verbatim by
// syncRosterFromTeam/bulk import, so a formula-leading verified email (e.g.
// `=1+1@evil.com`) would otherwise reach roster.csv and execute on open. NOT
// applied to github_id/tokens/hashes/timestamps, which must round-trip
// byte-exact.
//
// NOTE: this writes the leading quote into the STORED value, so any consumer of
// roster.csv (this app's parse layer, the gh-teacher CLI) must tolerate it on
// these fields. The Go writer defangs the same set; keep them in lockstep.
// Email matching keys on the normalized (trim+lowercase) email, so guarding the
// cell doesn't affect match-by-email.
const FORMULA_GUARDED_FIELDS = [
  "first_name",
  "last_name",
  "section",
  "email",
] as const

export function stringifyStudentsCsv(rows: StudentCsvRow[]) {
  const normalizedRows = rows
    .map((row) => normalizeStudentRow(row))
    .filter((row) => row.username || row.github_id || row.email)
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
