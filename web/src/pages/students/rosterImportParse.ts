import Papa from "papaparse"
import {
  isLikelyGithubUsername,
  normalizeGithubUsername,
  splitName,
} from "@/domain/students"
import { resolveGitHubId } from "@/util/identity"
import { isValidEmail, normalizeEmail } from "@/util/orgMembership"
import type { ClassroomRole } from "@/util/teamRoster"
import type { UploadKind } from "@/pages/students/uploadClassify"
import {
  IDENTITY_IMPORT_HEADERS,
  RECOGNIZED_IMPORT_HEADERS,
  type OptionalImportHeader,
} from "@/pages/students/rosterImportHeaders"

// Coerce a raw string to a ClassroomRole, or undefined when absent/unknown.
// Case-insensitive; the upload defaults undefined to "student" and lets the
// teacher override, so an unrecognized value degrades to student rather than
// failing the whole import. Exported so both the CSV parse and the preview
// Select coerce through one guard (no unchecked cast on raw input).
export const coerceImportRole = (
  raw: string | undefined,
): ClassroomRole | undefined => {
  const value = raw?.trim().toLowerCase()
  if (
    value === "student" ||
    value === "teacher" ||
    value === "hta" ||
    value === "ta"
  ) {
    return value
  }
  return undefined
}

// A row's identity cells exactly as the file spelled them, before any GitHub
// lookup. Resolution is async (an id must be traded for a current login), so the
// parser records the raw cells and rosterImportResolve turns them into an
// ImportIdentity.
export type UnresolvedIdentity = {
  // A canonical numeric id, already validated through resolveGitHubId. Undefined
  // when the cell was absent; `malformedGithubId` records a present-but-unusable
  // one so the preview can report it rather than silently ignoring it.
  githubId?: number
  malformedGithubId?: string
  username?: string
  email?: string
}

// A parsed row awaiting identity resolution. Deliberately a PAGES-layer type:
// the domain's ImportRosterRow stays username-keyed (every write path indexes by
// login), and startImport maps resolved account rows down to it.
export type ParsedImportRow = {
  identity: UnresolvedIdentity
  first_name?: string
  last_name?: string
  email?: string
  section?: string
  role?: ClassroomRole
}

// Why a non-empty line or row carried no usable identity, so the preview can
// report the count instead of silently shrinking the import.
export type DroppedRow = { line: number; reason: "no-identity" | "bad-email" }

export type ParsedImportFile = {
  rows: ParsedImportRow[]
  dropped: DroppedRow[]
}

const PAPA_OPTIONS = {
  header: true as const,
  delimiter: "",
  skipEmptyLines: "greedy" as const,
  transformHeader: (header: string) => header.trim().toLowerCase(),
}

// Papa emits a benign "Delimiter" warning for single-column input (a bare
// one-value-per-line list); that's not a structural defect. Only a genuine
// structural error (ragged rows, unclosed quotes) means the columns can't be
// trusted. Shared by the parser and the diagnostic so the two can't disagree
// about whether a file has a usable header row.
const structuralErrorOf = (
  errors: Papa.ParseError[],
): Papa.ParseError | undefined => errors.find((e) => e.type !== "Delimiter")

const stripMailto = (value: string) => value.replace(/^mailto:/i, "").trim()

// Read a row's identity cells in precedence order. A present-but-unusable
// github_id is recorded rather than ignored: falling back to the username cell
// would send the invite to whoever holds that login today, so the caller fails
// closed on it.
const readIdentity = (raw: Record<string, string>): UnresolvedIdentity => {
  const idCell = (raw.github_id ?? "").trim()
  const identity: UnresolvedIdentity = {}
  if (idCell) {
    const resolved = resolveGitHubId(idCell)
    if (resolved === null) identity.malformedGithubId = idCell
    else identity.githubId = resolved
  }
  const username = normalizeGithubUsername(raw.username ?? "")
  if (username && isLikelyGithubUsername(username)) identity.username = username
  const emailCell = stripMailto(raw.email ?? "")
  if (emailCell && isValidEmail(emailCell)) {
    identity.email = normalizeEmail(emailCell)
  }
  return identity
}

const hasAnyIdentity = (identity: UnresolvedIdentity) =>
  identity.githubId !== undefined ||
  identity.malformedGithubId !== undefined ||
  identity.username !== undefined ||
  identity.email !== undefined

// Parse an uploaded roster into rows carrying an UNRESOLVED identity plus
// metadata. A CSV with a header row reads github_id/username/email as identity
// columns (precedence in that order) and first_name/last_name/name/section/role
// as metadata, all case- and order-insensitive. Anything without a header row is
// read one value per line.
//
// `kind` is what makes the modal's format override real: "username-list" reads
// every bare line as a GitHub handle even when it looks like an address, while
// "roster-csv" (the default) detects each bare line. "email-list" never reaches
// here — that branch has its own line-oriented parser.
//
// Rows are NOT deduped here: two rows can only be known to name the same person
// after ids resolve, so rosterImportResolve owns dedupe.
export const parseRosterImportFile = (
  text: string,
  kind: UploadKind = "roster-csv",
): ParsedImportFile => {
  const trimmed = text.trim()
  if (!trimmed) return { rows: [], dropped: [] }

  const parsed = Papa.parse<Record<string, string>>(trimmed, PAPA_OPTIONS)
  const fields = parsed.meta.fields ?? []
  const structural = structuralErrorOf(parsed.errors)
  // A structural error means the columns can't be trusted, so don't quietly
  // re-read the file as a bare list — the caller surfaces `malformed` instead.
  if (structural) return { rows: [], dropped: [] }

  const hasIdentityColumn = IDENTITY_IMPORT_HEADERS.some((header) =>
    fields.includes(header),
  )

  const rows: ParsedImportRow[] = []
  const dropped: DroppedRow[] = []

  if (hasIdentityColumn) {
    parsed.data.forEach((raw, index) => {
      // +2: one for the header row, one for 1-based line numbers.
      const line = index + 2
      const identity = readIdentity(raw)
      if (!hasAnyIdentity(identity)) {
        // An email cell that failed validation is a likelier teacher mistake
        // than a wholly blank row, so name it specifically.
        const emailCell = stripMailto(raw.email ?? "")
        dropped.push({
          line,
          reason: emailCell ? "bad-email" : "no-identity",
        })
        return
      }
      const cell = (header: OptionalImportHeader): string =>
        (raw[header] ?? "").trim()
      // `name` fills first/last only when those split columns are ABSENT (not
      // merely empty), so a deliberately blank first_name isn't overwritten.
      const fromName = splitName(raw.name ?? null)
      rows.push({
        identity,
        first_name: (raw.first_name ?? fromName.first_name).trim(),
        last_name: (raw.last_name ?? fromName.last_name).trim(),
        email: identity.email ?? "",
        section: cell("section"),
        role: coerceImportRole(cell("role")),
      })
    })
    return { rows, dropped }
  }

  trimmed.split(/\r?\n/).forEach((rawLine, index) => {
    const line = index + 1
    const value = rawLine.trim()
    if (!value) return
    const bare = stripMailto(value)
    // Under the roster-csv default an address is an email identity; under the
    // username-list override the teacher has asserted every line is a handle.
    if (kind !== "username-list" && isValidEmail(bare)) {
      rows.push({
        identity: { email: normalizeEmail(bare) },
        email: normalizeEmail(bare),
      })
      return
    }
    const username = normalizeGithubUsername(value)
    if (!username || !isLikelyGithubUsername(username)) {
      dropped.push({ line, reason: "no-identity" })
      return
    }
    rows.push({ identity: { username } })
  })

  return { rows, dropped }
}

// Why an uploaded file yielded no importable rows, when the cause is the file's
// SHAPE rather than just unusable values. `null` means "no structural problem" —
// either a valid header file or a bare one-value-per-line list, both of which the
// parser handles; an empty result there is genuinely "no usable rows".
//   - missing-identity-header: the file has a header row (a delimiter or a
//     recognized column name) but none of github_id/username/email, so no row
//     can be addressed to anyone.
//   - malformed: Papa reported a structural parse error (ragged rows, unclosed
//     quote, ...), so the columns can't be trusted.
export type ImportHeaderIssue =
  | { kind: "missing-identity-header"; present: string[]; identity: string[] }
  | { kind: "malformed"; detail: string }

// Inspect an uploaded file's structure to explain an empty/mis-parsed import.
// Pure and side-effect-free so it's unit-testable and can run alongside
// parseRosterImportFile without re-reading the file. Deliberately does NOT flag
// a bare one-value-per-line list (a supported format): that is only "a header row
// missing an identity column" when the first line looks like headers.
export const detectImportHeaderIssue = (
  text: string,
): ImportHeaderIssue | null => {
  const trimmed = text.trim()
  if (!trimmed) return null

  const parsed = Papa.parse<Record<string, string>>(trimmed, PAPA_OPTIONS)
  const structural = structuralErrorOf(parsed.errors)
  if (structural) return { kind: "malformed", detail: structural.message }

  const fields = (parsed.meta.fields ?? []).map((f) => f.trim()).filter(Boolean)
  if (IDENTITY_IMPORT_HEADERS.some((header) => fields.includes(header))) {
    return null
  }

  // A header row is one with >1 column (a delimiter was found) or a single
  // recognized column name. A lone unrecognized token is a bare value list, not
  // a mis-headered CSV — leave it to the one-per-line fallback.
  const looksLikeHeaderRow =
    fields.length > 1 ||
    fields.some((f) =>
      (RECOGNIZED_IMPORT_HEADERS as readonly string[]).includes(f),
    )
  if (!looksLikeHeaderRow) return null

  return {
    kind: "missing-identity-header",
    present: fields,
    identity: [...IDENTITY_IMPORT_HEADERS],
  }
}

// Re-exported so the modal can advertise the identity columns in its
// missing-header copy without a second import path.
export { IDENTITY_IMPORT_HEADERS }
