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
  // the teacher has to edit, exactly like one found here. A row spanning a quoted
  // newline reports the line it ENDS on — still inside the record being edited.
  line: number
  identity: UnresolvedIdentity
  first_name?: string
  last_name?: string
  email?: string
  section?: string
  role?: ClassroomRole
}

// Why a row yielded no usable identity. A bad-* reason means a cell held content we
// couldn't use; `incomplete` means every identity cell was blank. The distinction
// drives both the copy and whether the import may proceed — see
// classifyImportProblems for that rule. A bad-* reason carries the offending cell
// (and only there: `incomplete` has nothing to show) so the report can name the
// value instead of just counting.
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

// Split a flat file into lines on any of the three terminators. A lone CR is a
// legacy Mac / older Excel export; splitting only on LF would read such a file as
// one long line.
const splitLines = (text: string) => text.split(/\r\n|\r|\n/)

// Count line breaks, honouring the terminator Papa detected. A legacy Mac / older
// Excel export uses a lone CR, where counting only LF would report every row as
// line 1 — and identical line+reason pairs also collide as React keys in the
// report. CRLF is counted by its trailing LF, so only a lone CR needs the branch.
const countLines = (s: string, newline: string) => {
  const cr = newline === "\r"
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (cr ? c === 13 : c === 10) n++
  }
  return n
}

// Parse a headed CSV, pairing each row with its TRUE 1-based file line.
//
// Papa skips blank rows (`skipEmptyLines: greedy`), so a row's index is not its
// line, and a reported line number is the teacher's only handle on the row to
// edit. Rather than re-deriving the mapping by splitting on newlines — which
// diverges from Papa the moment a quoted field contains one — use the per-row
// `cursor` Papa reports through `step`: the offset it has consumed through the end
// of that row, terminating newline included. Counting the newlines before it is
// then Papa's own idea of where the row sits, so the two cannot drift.
//
// `text` must arrive BOM-free (parseRosterImportFile strips it): Papa's cursors are
// offsets into the text it stripped internally. And a final row with no trailing
// newline ends the file without consuming one, so it takes the +1 that newline would
// have contributed — otherwise it inherits the previous row's number, which also
// collides as a React key in the report.
const parseRowsWithLines = (text: string) => {
  const rows: { raw: Record<string, string>; line: number }[] = []
  // In `step` mode Papa reports each row's errors to the callback and leaves the
  // top-level `errors` empty, so collect them here or the malformed-CSV guard
  // would never fire.
  const errors: Papa.ParseError[] = []
  const pending: { raw: Record<string, string>; cursor: number }[] = []
  const parsed = Papa.parse<Record<string, string>>(text, {
    ...PAPA_OPTIONS,
    step: (result: Papa.ParseStepResult<Record<string, string>>) => {
      errors.push(...result.errors)
      pending.push({ raw: result.data, cursor: result.meta.cursor })
    },
  })
  // meta.linebreak is only known once parsing has run, so number the rows after.
  const newline = parsed.meta.linebreak || "\n"
  const endCode = newline === "\r" ? 13 : 10
  let consumed = 0
  let lines = 0
  for (const { raw, cursor } of pending) {
    // Advance from the previous row's end, so the file is scanned once overall
    // rather than once per row.
    lines += countLines(text.slice(consumed, cursor), newline)
    consumed = cursor
    const unterminated = text.charCodeAt(cursor - 1) !== endCode
    rows.push({ raw, line: lines + (unterminated ? 1 : 0) })
  }
  return { rows, fields: parsed.meta.fields ?? [], errors }
}

// Read a row's identity cells in precedence order. A present-but-unusable
// Read a row's identity cells in precedence order, reporting any cell whose
// content we could not use. A present-but-unusable github_id is recorded ON the
// identity (so resolution reports it as an unresolvable id rather than the parser
// calling the row empty) — falling back to the username cell would send the invite
// to whoever holds that login today, so the caller fails closed on it.
//
// The other two report through `rejected`, and deliberately do so even when the
// row is otherwise importable: a shifted column usually leaves ONE cell garbled
// beside a good one, and silently importing that row would write the garbage as
// the student's stored address while reporting nothing. See classifyImportProblems.
const readIdentity = (
  raw: Record<string, string>,
  line: number,
): { identity: UnresolvedIdentity; rejected: DroppedRow[] } => {
  const idCell = (raw.github_id ?? "").trim()
  const identity: UnresolvedIdentity = {}
  const rejected: DroppedRow[] = []
  if (idCell) {
    const resolved = resolveGitHubId(idCell)
    if (resolved === null) identity.malformedGithubId = idCell
    else identity.githubId = resolved
  }
  const usernameCell = (raw.username ?? "").trim()
  const username = normalizeGithubUsername(raw.username ?? "")
  if (username && isLikelyGithubUsername(username)) {
    identity.username = username
  } else if (usernameCell) {
    rejected.push({ line, reason: "bad-username", value: usernameCell })
  }
  const emailCell = stripMailto(raw.email ?? "")
  if (emailCell && isValidEmail(emailCell)) {
    identity.email = normalizeEmail(emailCell)
  } else if (emailCell) {
    rejected.push({ line, reason: "bad-email", value: emailCell })
  }
  return { identity, rejected }
}

const hasAnyIdentity = (identity: UnresolvedIdentity) =>
  identity.githubId !== undefined ||
  identity.malformedGithubId !== undefined ||
  identity.username !== undefined ||
  identity.email !== undefined

// The index of a leading caption line to skip, or -1.
//
// A spreadsheet export of a single column starts with that column's title. Papa
// reads a one-column first line as data and looksLikeHeaderRow can't recognize it,
// so left alone the caption is either reported as unusable content — blocking the
// whole file — or, when it happens to be handle-shaped, imported as a student named
// after a column.
//
// The signal is deliberately narrow: the line must BE a recognized column name.
// "It didn't parse but a later line did" is not enough — that describes a typo'd
// first entry just as well as a caption, and guessing would silently omit a student
// the teacher listed, which is the failure this whole change exists to remove. An
// unrecognized bad first line stays reported.
const captionLineIndex = (lines: readonly string[]): number => {
  const first = lines.findIndex((l) => l.trim() !== "")
  if (first < 0) return -1
  const value = lines[first]!.trim().toLowerCase()
  return (RECOGNIZED_IMPORT_HEADERS as readonly string[]).includes(value)
    ? first
    : -1
}

// Read every line of a flat file as an email address, for the email-list
// override. Addresses are normalized, exactly as the default kind already does
// for a bare address list: identityKey is derived from the address, so keeping
// the file's casing would make `Ada@x.edu` and `ada@x.edu` two identities and
// invite the same person twice.
const parseAddressList = (text: string): ParsedImportFile => {
  const rows: ParsedImportRow[] = []
  const dropped: DroppedRow[] = []
  // Split the ORIGINAL text, not a trimmed copy: a reported line number is the
  // teacher's only way to find the row, so leading blank lines must still count.
  const lines = splitLines(text)
  const caption = captionLineIndex(lines)
  lines.forEach((rawLine, index) => {
    const line = index + 1
    const value = rawLine.trim()
    if (!value) return
    if (index === caption) return
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

// Read a header-less file one value per line, detecting each line's shape. Used
// for the roster-csv default (a bare list, either shape per line) and for the
// username-list override, where the teacher has asserted every line is a handle so
// an address-shaped line is reported rather than re-read as an email identity.
const parseFlatList = (text: string, kind: UploadKind): ParsedImportFile => {
  const rows: ParsedImportRow[] = []
  const dropped: DroppedRow[] = []
  const asHandlesOnly = kind === "username-list"
  // Split the ORIGINAL text, so a reported line number matches what the teacher
  // sees in their editor even when the file opens with blank lines.
  const lines = splitLines(text)
  const caption = captionLineIndex(lines)

  lines.forEach((rawLine, index) => {
    const line = index + 1
    const value = rawLine.trim()
    if (!value) return
    if (index === caption) return
    const bare = stripMailto(value)
    if (!asHandlesOnly && isValidEmail(bare)) {
      const email = normalizeEmail(bare)
      rows.push({ line, identity: { email }, email })
      return
    }
    const username = normalizeGithubUsername(value)
    if (!username || !isLikelyGithubUsername(username)) {
      // Under the override the teacher named the shape, so blame that shape;
      // under the default the line could have been either and was neither.
      dropped.push({
        line,
        reason: asHandlesOnly ? "bad-username" : "bad-value",
        value,
      })
      return
    }
    rows.push({ line, identity: { username } })
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
// Rows are NOT deduped here: two rows can only be known to name the same person
// after ids resolve, so rosterImportResolve owns dedupe.
export const parseRosterImportFile = (
  rawText: string,
  kind: UploadKind = "roster-csv",
): ParsedImportFile => {
  // Strip a leading BOM once, up front, so every reader below sees plain text.
  // Papa strips one internally, so its row cursors would otherwise sit one
  // character ahead of the string parseRowsWithLines slices to count lines. That
  // shift happens to cancel out today (every row then looks unterminated and takes
  // the same +1), which is a coincidence worth not depending on — Excel's
  // "CSV UTF-8" export writes a BOM, so this is a common file.
  const text = rawText.replace(/^\uFEFF/, "")
  if (!text.trim()) return { rows: [], dropped: [] }

  // Before any CSV reading: an override is the teacher asserting what EVERY line
  // is, so a header row is data too. Papa.parse would otherwise consume the first
  // line as headers and take the columnar branch on a file they explicitly told us
  // was a flat list.
  if (kind === "email-list") return parseAddressList(text)
  if (kind === "username-list") return parseFlatList(text, kind)

  // Parse the un-trimmed text, so each row's cursor is an offset into the file the
  // teacher is looking at and a leading blank line still counts.
  const { rows: rawRows, fields, errors } = parseRowsWithLines(text)
  const structural = structuralErrorOf(errors)
  // A structural error means the columns can't be trusted, so don't quietly
  // re-read the file as a bare list — the caller surfaces `malformed` instead.
  if (structural) return { rows: [], dropped: [] }

  const hasIdentityColumn = IDENTITY_IMPORT_HEADERS.some((header) =>
    fields.includes(header),
  )

  const rows: ParsedImportRow[] = []
  const dropped: DroppedRow[] = []

  // A file with a header row but no identity column has a SHAPE problem, not a
  // row-content problem: re-reading it one value per line would blame the header
  // and every data row for not being a username, burying the one message that
  // helps ("add a github_id, username, or email column"). Yield nothing and let
  // detectImportHeaderIssue explain it.
  if (!hasIdentityColumn && looksLikeHeaderRow(fields)) {
    return { rows: [], dropped: [] }
  }

  if (hasIdentityColumn) {
    rawRows.forEach(({ raw, line }) => {
      const { identity, rejected } = readIdentity(raw, line)
      // Every unusable cell is reported, whether or not the row survives.
      dropped.push(...rejected)
      if (!hasAnyIdentity(identity)) {
        // A row with nothing usable AND nothing to blame is merely incomplete —
        // no identity cell was filled in at all. Anything blameable was already
        // pushed above, so don't double-report it.
        if (rejected.length === 0) dropped.push({ line, reason: "incomplete" })
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
        // Dropped when the cell didn't parse as an address, so a value we've
        // already called unusable can never be stored as someone's contact email.
        email: identity.email ? (raw.email ?? "").trim() : "",
        section: cell("section"),
        role: coerceImportRole(cell("role")),
      })
    })
    return { rows, dropped }
  }

  return parseFlatList(text, kind)
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

// Whether a file's first row is a HEADER row rather than the first of a bare list:
// more than one column (a delimiter was found), or a single recognized column name.
// A lone unrecognized token is a bare value list. Shared by the parser and the
// diagnostic below so the two can't disagree about which shape a file is.
const looksLikeHeaderRow = (fields: readonly string[]) =>
  fields.length > 1 ||
  fields.some((f) =>
    (RECOGNIZED_IMPORT_HEADERS as readonly string[]).includes(f),
  )

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
  if (!looksLikeHeaderRow(fields)) return null

  return {
    kind: "missing-identity-header",
    present: fields,
    identity: [...IDENTITY_IMPORT_HEADERS],
  }
}

// Re-exported so the modal can advertise the identity columns in its
// missing-header copy without a second import path.
export { IDENTITY_IMPORT_HEADERS }
