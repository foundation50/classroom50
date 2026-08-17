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
  // The row's 1-based line in the uploaded file, carried so a problem found
  // downstream (an id that resolves to nothing) can be reported against the line
  // the teacher has to edit, exactly like one found here.
  line: number
  identity: UnresolvedIdentity
  first_name?: string
  last_name?: string
  email?: string
  section?: string
  role?: ClassroomRole
}

// Why a row yielded no usable identity. The distinction drives BOTH the copy and
// whether the import may proceed, so the two can't drift:
//   - a bad-* reason means a cell held content we couldn't use. Something is
//     wrong with the file (a typo, a shifted column, the wrong file entirely),
//     the teacher can see exactly what, and the import is blocked on it.
//   - `incomplete` means every identity cell was blank — a student who hasn't
//     supplied a handle yet. There is nothing to fix, so the row is reported and
//     skipped rather than blocking the students who ARE addressable.
// The offending cell rides along on a bad-* reason (and only there: `incomplete`
// has nothing to show) so the report can name the value instead of just counting.
export type DroppedRow =
  | { line: number; reason: BlockingDropReason; value: string }
  | { line: number; reason: "incomplete" }

export type BlockingDropReason =
  // A username/email cell whose content isn't a valid handle/address.
  | "bad-username"
  | "bad-email"
  // A bare one-per-line value that is neither, so we can't even guess which the
  // teacher meant.
  | "bad-value"

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

// Which cell to blame for a row that yielded no identity, in the order a teacher
// most likely meant the row to be read. A malformed github_id never reaches here:
// it is recorded ON the identity, so resolution reports it as an unresolvable id
// rather than the parser calling the row empty.
const blameFor = (raw: Record<string, string>, line: number): DroppedRow => {
  const email = stripMailto(raw.email ?? "")
  if (email) return { line, reason: "bad-email", value: email }
  const username = (raw.username ?? "").trim()
  if (username) return { line, reason: "bad-username", value: username }
  return { line, reason: "incomplete" }
}

// Read every line of a flat file as an email address, for the email-list
// override. Addresses are normalized, exactly as the default kind already does
// for a bare address list: identityKey is derived from the address, so keeping
// the file's casing would make `Ada@x.edu` and `ada@x.edu` two identities and
// invite the same person twice.
const parseAddressList = (trimmed: string): ParsedImportFile => {
  const rows: ParsedImportRow[] = []
  const dropped: DroppedRow[] = []
  trimmed.split(/\r?\n/).forEach((rawLine, index) => {
    const line = index + 1
    const value = rawLine.trim()
    if (!value) return
    const bare = stripMailto(value)
    if (!isValidEmail(bare)) {
      dropped.push({ line, reason: "bad-email", value })
      return
    }
    const email = normalizeEmail(bare)
    rows.push({ line, identity: { email }, email })
  })
  return { rows, dropped }
}

// Parse an uploaded roster into rows carrying an UNRESOLVED identity plus
// metadata. A CSV with a header row reads github_id/username/email as identity
// columns (precedence in that order) and first_name/last_name/name/section/role
// as metadata, all case- and order-insensitive. Anything without a header row is
// read one value per line.
//
// `kind` is what makes the modal's format override real, and each override is an
// assertion by the teacher about EVERY line, so neither does any columnar reading:
//   - "username-list" reads every line as a GitHub handle, even one shaped like
//     an address;
//   - "email-list" reads every line as an address, even one shaped like a handle.
// A line that contradicts the assertion is dropped rather than re-read as the
// other shape — silently importing `octocat` as an email row (or vice versa) from
// a file the teacher told us the shape of would defeat the point of the override.
// "roster-csv" (the default) detects each bare line instead.
//
// Rows are NOT deduped here: two rows can only be known to name the same person
// after ids resolve, so rosterImportResolve owns dedupe.
export const parseRosterImportFile = (
  text: string,
  kind: UploadKind = "roster-csv",
): ParsedImportFile => {
  const trimmed = text.trim()
  if (!trimmed) return { rows: [], dropped: [] }

  // Before any CSV reading: under the email override every line is an address, so
  // a header row is data too. Papa.parse would otherwise consume the first line
  // as headers and take the columnar branch on a file the teacher explicitly told
  // us was a flat list.
  if (kind === "email-list") return parseAddressList(trimmed)

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
        dropped.push(blameFor(raw, line))
        return
      }
      const cell = (header: OptionalImportHeader): string =>
        (raw[header] ?? "").trim()
      // `name` fills first/last only when those split columns are ABSENT (not
      // merely empty), so a deliberately blank first_name isn't overwritten.
      const fromName = splitName(raw.name ?? null)
      rows.push({
        line,
        identity,
        first_name: (raw.first_name ?? fromName.first_name).trim(),
        last_name: (raw.last_name ?? fromName.last_name).trim(),
        // The RAW cell, not the normalized identity address: metadata is compared
        // case-sensitively against the stored roster, so lower-casing here would
        // report a delta on every row whose stored address has a capital letter.
        email: (raw.email ?? "").trim(),
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
        line,
        identity: { email: normalizeEmail(bare) },
        email: normalizeEmail(bare),
      })
      return
    }
    const username = normalizeGithubUsername(value)
    if (!username || !isLikelyGithubUsername(username)) {
      // Under the override the teacher named the shape, so blame that shape;
      // under the default the line could have been either and was neither.
      dropped.push({
        line,
        reason: kind === "username-list" ? "bad-username" : "bad-value",
        value,
      })
      return
    }
    rows.push({ line, identity: { username } })
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
