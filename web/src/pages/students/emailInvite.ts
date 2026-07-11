import { normalizeEmail, isValidEmail } from "@/util/orgMembership"
import type { RosterRole } from "@/util/teamRoster"

// A single parsed email-invite target. `role` is chosen in the preview UI (not
// the file), so the parser leaves it undefined and the modal defaults it.
export type EmailInviteRow = {
  email: string
  role?: RosterRole
}

// Parse a one-email-per-line file (.txt or .csv) into invite targets. Deliberately
// line-oriented, NOT CSV-columnar: this flow invites by email only (no username,
// no name/section), so any commas are treated as part of the line and the whole
// trimmed line must be a single valid email. A leading `mailto:` (copied from a
// mail client) is stripped. Invalid lines are dropped; emails are deduped
// case-insensitively, keeping the first occurrence. Exported for unit testing.
export const parseEmailInviteFile = (text: string): EmailInviteRow[] => {
  const seen = new Set<string>()
  const rows: EmailInviteRow[] = []

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine
      .trim()
      .replace(/^mailto:/i, "")
      .trim()
    if (!line || !isValidEmail(line)) continue
    const key = normalizeEmail(line)
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ email: line })
  }

  return rows
}
