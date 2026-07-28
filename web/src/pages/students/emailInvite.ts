import { normalizeEmail, isValidEmail } from "@/util/orgMembership"
import type { ClassroomRole } from "@/util/teamRoster"

// A single parsed email-invite target. `role` is chosen in the preview UI (not
// the file), so the parser leaves it undefined and the modal defaults it.
export type EmailInviteRow = {
  email: string
  role?: ClassroomRole
}

// A non-empty line that isn't a valid email address, with its 1-based file line
// number and the raw (trimmed, mailto-stripped) value, so the UI can point the
// teacher at exactly which rows to fix.
export type InvalidEmailLine = {
  line: number
  value: string
}

export type ParsedEmailInviteFile = {
  valid: EmailInviteRow[]
  // Non-empty lines that failed validation (empty lines are skipped silently).
  invalid: InvalidEmailLine[]
}

// Parse a one-email-per-line file (.txt or .csv) into invite targets. Deliberately
// line-oriented, NOT CSV-columnar: this flow invites by email only (no username,
// no name/section), so any commas are treated as part of the line and the whole
// trimmed line must be a single valid email. A leading `mailto:` (copied from a
// mail client) is stripped. Empty/whitespace-only lines are skipped silently; a
// non-empty line that isn't a valid email is collected in `invalid` (with its
// file line number) so the UI can flag it rather than dropping it silently.
// Valid emails are deduped case-insensitively, keeping the first occurrence.
// Exported for unit testing.
export const parseEmailInviteFile = (text: string): ParsedEmailInviteFile => {
  const seen = new Set<string>()
  const valid: EmailInviteRow[] = []
  const invalid: InvalidEmailLine[] = []

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine
      .trim()
      .replace(/^mailto:/i, "")
      .trim()
    if (!line) return
    if (!isValidEmail(line)) {
      invalid.push({ line: index + 1, value: line })
      return
    }
    const key = normalizeEmail(line)
    if (seen.has(key)) return
    seen.add(key)
    valid.push({ email: line })
  })

  return { valid, invalid }
}
