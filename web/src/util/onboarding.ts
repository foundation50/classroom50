// Email + invite-token helpers shared by the CSV write path (students.ts) and
// the roster UI. (The self-report / onboarding-repo machinery this file once
// also held was removed with the team-as-source-of-truth rework.)

import { bytesToHex } from "./hex"

// 128 bits of CSPRNG randomness as 32-char lowercase hex (unguessable,
// collision-proof). Backs the per-student invite token minted on CSV rows.
function random128BitHex(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

// Optional per-student invite token minted onto a roster row. Retained as an
// opaque identifier written at invite time (it never names a repo).
export function generateInviteToken(): string {
  return random128BitHex()
}

// The classroom team slug a STUDENT derives (the authoritative slug is in the
// private classroom.json they can't read). Safe-degrade: on a slug collision the
// derived slug 404s and the membership read simply reports "not a member", so a
// miss never grants false access. The teacher side reads the real slug via
// resolveClassroomTeam.
export function classroomTeamSlugHeuristic(classroom: string): string {
  return `classroom50-${classroom}`
}

// Canonical form for hashing/comparison. Lowercase + trim only: deliberately do
// NOT strip Gmail-style `+tags` or dots, since those are provider-specific and
// would collapse genuinely distinct addresses onto one key.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

// Minimal email shape check. Deliberately permissive (GitHub is the real
// validator at invite time); only catches obvious typos before committing.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email.trim())
}

// SHA-256 of the normalized email, truncated to 16 hex chars. Cached on the
// row as `email_hash` so the cross-classroom email->identity resolver can match
// an email-first row without storing the raw email twice. Async per Web
// Crypto's subtle.digest.
export async function emailHash(email: string): Promise<string> {
  const data = new TextEncoder().encode(normalizeEmail(email))
  const digest = await crypto.subtle.digest("SHA-256", data)
  return bytesToHex(new Uint8Array(digest)).slice(0, 16)
}

// Whether a candidate email matches a row's email_hash (or raw email), given the
// candidate email's precomputed hash. Used by the email-invite identity resolver
// to bind an email-first row to a GitHub id found on another classroom's roster.
// Falls through to true for a github_id-keyed row with no email, where the
// caller relies on the immutable id. Synchronous so a caller matching one email
// against many rows hashes it only once.
export function rowMatchesEmailHash(
  row: { email?: string; email_hash?: string },
  candidateEmail: string,
  candidateEmailHash: string,
): boolean {
  if (row.email_hash) {
    return candidateEmailHash === row.email_hash
  }
  if (row.email?.trim()) {
    return normalizeEmail(candidateEmail) === normalizeEmail(row.email)
  }
  return true
}
