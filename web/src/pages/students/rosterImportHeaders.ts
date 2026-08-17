// The single source of truth for the roster-import header vocabulary, shared by
// the parser (parseRosterImportFile), the empty-result diagnostic
// (detectImportHeaderIssue), and the upload classifier (classifyUploadFile).
// Keeping one exported set is what lets those three agree on whether a first
// line is a header row and which columns to advertise — a second hand-synced
// copy would silently drift (a new column added to one and not the others flips
// classification vs. diagnosis).

// Columns that can identify a row, in PRECEDENCE order: a `github_id` wins over
// a `username`, which wins over an `email`. A row needs at least one of them.
//
// The order encodes provenance, not a general id-over-login rule: a `github_id`
// column is produced only by Classroom 50's own roster.csv, so it addresses an
// immutable account, while a `username` column is what an SIS export or a
// hand-typed list produces. `email` identifies a student who has no GitHub
// account on file yet, and routes to an email invitation instead of an enroll.
export const IDENTITY_IMPORT_HEADERS = [
  "github_id",
  "username",
  "email",
] as const

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
// one-value-per-line list, so a file whose only column is `github_id` is
// diagnosed as a mis-headered CSV instead of treated as a username list.
export const RECOGNIZED_IMPORT_HEADERS = [
  ...IDENTITY_IMPORT_HEADERS,
  ...OPTIONAL_IMPORT_HEADERS,
] as const

export type IdentityImportHeader = (typeof IDENTITY_IMPORT_HEADERS)[number]
export type OptionalImportHeader = (typeof OPTIONAL_IMPORT_HEADERS)[number]
