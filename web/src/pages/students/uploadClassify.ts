import { isValidEmail } from "@/util/orgMembership"
import { RECOGNIZED_IMPORT_HEADERS } from "@/pages/students/rosterImportHeaders"

// Which of the three supported upload formats a file is. Drives the unified
// upload modal's routing (and the auto-detected default the teacher can
// override):
//   - roster-csv:     a structured CSV with a header row (username + optional
//                     name/email/section/role) -> roster import
//   - username-list:  one GitHub username per line -> roster import (headerless)
//   - email-list:     one email address per line -> email invitations
export type UploadKind = "roster-csv" | "username-list" | "email-list"

// One source: the same header vocabulary the parser and the header-issue
// diagnostic use, so classification can't drift from them.
const HEADER_TOKENS = new Set<string>(RECOGNIZED_IMPORT_HEADERS)

const nonEmptyLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

const stripMailto = (line: string): string =>
  line.replace(/^mailto:/i, "").trim()

// A first line is a "header row" when it has a delimiter (>1 comma-separated
// cell) or its sole cell is a recognized roster column name.
const looksLikeHeaderRow = (firstLine: string): boolean => {
  const cells = firstLine.split(",").map((c) => c.trim().toLowerCase())
  if (cells.length > 1) return true
  return HEADER_TOKENS.has(cells[0] ?? "")
}

// Classify an uploaded file by content. Precedence (best guess; the modal shows
// it and lets the teacher override):
//   1. email-list  — the majority of non-empty lines are valid emails AND the
//      first line isn't a roster header. Emails and GitHub handles are disjoint
//      (`@`+dot vs. the handle charset), so this rarely misfires.
//   2. roster-csv  — the first line is a header row (a delimiter, or a
//      recognized roster column name).
//   3. username-list — the default: bare one-handle-per-line.
// An empty/whitespace file defaults to username-list (the modal will just show
// "no valid usernames"). Deterministic and pure for unit testing.
export const classifyUploadFile = (text: string): UploadKind => {
  const lines = nonEmptyLines(text)
  if (lines.length === 0) return "username-list"

  const firstIsHeader = looksLikeHeaderRow(lines[0])

  // Email detection ignores a header row (a CSV's header line isn't data).
  const dataLines = firstIsHeader ? lines.slice(1) : lines
  const emailCount = dataLines.filter((l) =>
    isValidEmail(stripMailto(l)),
  ).length
  if (
    !firstIsHeader &&
    emailCount > 0 &&
    emailCount >= Math.ceil(dataLines.length / 2)
  ) {
    return "email-list"
  }

  if (firstIsHeader) return "roster-csv"

  // Fall through: a bare list. It's usernames unless it's actually emails (the
  // majority-email check above already caught the email case), so username-list.
  return "username-list"
}
