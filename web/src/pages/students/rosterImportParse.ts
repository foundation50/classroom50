import Papa from "papaparse"
import {
  isLikelyGithubUsername,
  normalizeGithubUsername,
  splitName,
  type ImportRosterRow,
} from "@/domain/students"
import type { ClassroomRole } from "@/util/teamRoster"
import {
  OPTIONAL_IMPORT_HEADERS,
  RECOGNIZED_IMPORT_HEADERS,
  type OptionalImportHeader,
} from "@/pages/students/rosterImportHeaders"

// Coerce a raw string to a ClassroomRole, or undefined when absent/unknown.
// Case-insensitive; the upload defaults undefined to "student" and lets the
// instructor override, so an unrecognized value degrades to student rather than
// failing the whole import. Exported so both the CSV parse and the preview
// Select coerce through one guard (no unchecked cast on raw input).
export const coerceImportRole = (
  raw: string | undefined,
): ClassroomRole | undefined => {
  const value = raw?.trim().toLowerCase()
  if (value === "student" || value === "instructor" || value === "ta") {
    return value
  }
  return undefined
}

// Parse an uploaded roster into metadata rows. A CSV with a `username` header
// column also honors first_name/last_name/name/email/section columns (case- and
// order-insensitive); anything without a header falls back to one-username-per
// -line. github_id in the file is ignored — it's re-derived from GitHub on
// import so the stored id is authoritative. Rows are deduped by username.
// Exported for unit testing.
export const parseRosterImportFile = (text: string): ImportRosterRow[] => {
  const trimmed = text.trim()
  if (!trimmed) return []

  const parsed = Papa.parse<Record<string, string>>(trimmed, {
    header: true,
    delimiter: "",
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim().toLowerCase(),
  })

  const fields = parsed.meta.fields ?? []
  const hasUsernameColumn =
    parsed.errors.length === 0 && fields.includes("username")

  const seen = new Set<string>()
  const rows: ImportRosterRow[] = []

  const push = (row: ImportRosterRow) => {
    const username = normalizeGithubUsername(row.username)
    if (!username || !isLikelyGithubUsername(username)) return
    const key = username.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    rows.push({ ...row, username })
  }

  if (hasUsernameColumn) {
    for (const raw of parsed.data) {
      // Read the optional columns generically from the shared header list so
      // the parser can't drift from what the diagnostic advertises. Two columns
      // get special handling on top of the generic read: `name` is an alias
      // that fills first/last when those split columns are ABSENT (not merely
      // empty), and `role` is coerced through the known-role guard.
      const cell = (header: OptionalImportHeader): string =>
        (raw[header] ?? "").trim()
      const fromName = splitName(raw.name ?? null)
      push({
        username: raw.username ?? "",
        first_name: (raw.first_name ?? fromName.first_name).trim(),
        last_name: (raw.last_name ?? fromName.last_name).trim(),
        email: cell("email"),
        section: cell("section"),
        role: coerceImportRole(cell("role")),
      })
    }
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      push({ username: line })
    }
  }

  return rows
}

// Why an uploaded file yielded no importable rows, when the cause is the file's
// SHAPE rather than just invalid handles. `null` means "no structural problem" —
// either a valid header file or a bare one-username-per-line list, both of which
// the parser handles; an empty result there is genuinely "no valid usernames".
//   - missing-username-header: the file has a header row (a delimiter or a
//     recognized column name) but no `username` column, so the required field
//     can't be mapped. We surface the required + optional columns instead of
//     silently falling back to treating each line as a username.
//   - malformed: Papa reported a structural parse error (ragged rows, unclosed
//     quote, ...), so the columns can't be trusted.
export type ImportHeaderIssue =
  | { kind: "missing-username-header"; present: string[]; optional: string[] }
  | { kind: "malformed"; detail: string }

// Inspect an uploaded file's structure to explain an empty/mis-parsed import.
// Pure and side-effect-free so it's unit-testable and can run alongside
// parseRosterImportFile without re-reading the file. Deliberately does NOT flag
// a bare one-username-per-line list (the supported headerless format): that is
// only "a header row missing username" when the first line looks like headers.
export const detectImportHeaderIssue = (
  text: string,
): ImportHeaderIssue | null => {
  const trimmed = text.trim()
  if (!trimmed) return null

  const parsed = Papa.parse<Record<string, string>>(trimmed, {
    header: true,
    delimiter: "",
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim().toLowerCase(),
  })

  // Papa emits a benign "Delimiter" warning for single-column input (a bare
  // username list) — that's not a structural defect, so ignore it. Only genuine
  // structural errors (ragged rows, unclosed quotes) mean "malformed".
  const structuralError = parsed.errors.find((e) => e.type !== "Delimiter")
  if (structuralError) {
    return { kind: "malformed", detail: structuralError.message }
  }

  const fields = (parsed.meta.fields ?? []).map((f) => f.trim()).filter(Boolean)
  if (fields.includes("username")) return null

  // A header row is one with >1 column (a delimiter was found) or a single
  // recognized column name. A lone unrecognized token is a bare username list,
  // not a mis-headered CSV — leave it to the one-per-line fallback.
  const looksLikeHeaderRow =
    fields.length > 1 ||
    fields.some((f) =>
      (RECOGNIZED_IMPORT_HEADERS as readonly string[]).includes(f),
    )
  if (!looksLikeHeaderRow) return null

  return {
    kind: "missing-username-header",
    present: fields,
    optional: [...OPTIONAL_IMPORT_HEADERS],
  }
}
