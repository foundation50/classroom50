// The single source of truth for the roster-import header vocabulary, shared by
// the parser (parseRosterImportFile), the empty-result diagnostic
// (detectImportHeaderIssue), and the upload classifier (classifyUploadFile).
// Keeping one exported set is what lets those three agree on whether a first
// line is a header row and which optional columns to advertise — a second
// hand-synced copy would silently drift (a new column added to one and not the
// others flips classification vs. diagnosis).

// Optional columns the import reads when a `username` column is present
// (case-insensitive). `name` is an alias split into first/last. `github_id` is
// intentionally NOT here — it's re-derived from GitHub on import, so it is never
// advertised as an optional column even though it is recognized as a header
// token below.
export const OPTIONAL_IMPORT_HEADERS = [
  "first_name",
  "last_name",
  "name",
  "email",
  "section",
  "role",
] as const

// Header tokens that mark the first line as a real header row rather than a bare
// one-username-per-line list. Adds `username` (the required column) and the
// ignored-but-recognized `github_id` so a file whose only column is `github_id`
// is diagnosed as a mis-headered CSV instead of treated as a username list.
export const RECOGNIZED_IMPORT_HEADERS = [
  "username",
  "github_id",
  ...OPTIONAL_IMPORT_HEADERS,
] as const

export type OptionalImportHeader = (typeof OPTIONAL_IMPORT_HEADERS)[number]
