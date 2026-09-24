import { IDENTITY_CSV_FIELDS } from "@/util/rosterCsv"

// The single source of truth for the roster-import header vocabulary, shared by
// the parser (parseRosterImportFile) and the empty-result diagnostic
// (detectImportHeaderIssue). Keeping one exported set is what lets those two
// agree on whether a first line is a header row and which columns to advertise —
// a second hand-synced copy would silently drift.

// Columns that can identify a row, in PRECEDENCE order: a `github_id` wins over
// a `username`, which wins over an `email`. A row needs at least one of them.
// The same set gates the stored roster.csv reader (parseRosterCsv), so the two
// header policies can't diverge.
export const IDENTITY_IMPORT_HEADERS = IDENTITY_CSV_FIELDS

// Columns the import reads as metadata once a row's identity is established.
// `name` is an alias split into first/last. `email` is deliberately NOT here: it
// is an identity column above, and is read as metadata for every row regardless.
export const OPTIONAL_IMPORT_HEADERS = [
  "first_name",
  "last_name",
  "name",
  "section",
  "role",
] as const

// Header tokens that mark the first line as a real header row rather than a bare
// one-value-per-line list, so a file whose only column is `section` is diagnosed
// as a header row missing an identity column instead of being read as a list of
// usernames.
export const RECOGNIZED_IMPORT_HEADERS = [
  ...IDENTITY_IMPORT_HEADERS,
  ...OPTIONAL_IMPORT_HEADERS,
] as const

export type OptionalImportHeader = (typeof OPTIONAL_IMPORT_HEADERS)[number]
