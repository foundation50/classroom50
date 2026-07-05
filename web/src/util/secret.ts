// Capability-URL secret helpers for protected classrooms. Kept in lockstep with
// the CLI's cli/gh-teacher/internal/configrepo/secret.go and the classroom-v1 /
// repo-config-v1 JSON schemas: a secret is a single safe URL path segment, 4-64
// lowercase-alphanumeric chars. When set, published Pages resources live under
// `<classroom>/<secret>/...` instead of the guessable `<classroom>/...`.

const SECRET_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

// Default generated length when a teacher opts in without typing their own.
// 8 chars of [a-z0-9] is ~41 bits — ample anti-discovery friction (not crypto).
export const DEFAULT_SECRET_LENGTH = 8

// Matches the CLI's SecretPattern exactly. Anchored so a value with a stray
// separator (`/`, `-`, space) or uppercase is rejected before it can become a
// bad path segment.
export const SECRET_PATTERN = /^[a-z0-9]{4,64}$/

export const SECRET_PATTERN_DESCRIPTION =
  "4-64 lowercase letters or digits ([a-z0-9])"

// isValidSecret reports whether a secret is a safe path segment. An empty
// string is NOT valid; callers that allow "no secret" (the unprotected default)
// must branch on emptiness first.
export function isValidSecret(secret: string): boolean {
  return SECRET_PATTERN.test(secret)
}

// classroomPagesSegment builds the Pages path segment: the guessable
// `<classroom>` when no secret is set, or the unlisted `<classroom>/<secret>`
// capability path when it is. Single source of truth for the invariant every
// Pages URL builder depends on (pagesAssignmentUrl/pagesAutograderUrl and the
// Published Resources page). The secret is encoded defensively — it is already
// `[a-z0-9]`-constrained at every trust boundary, but encoding stops a future
// looser source from injecting a path.
export function classroomPagesSegment(
  classroom: string,
  secret?: string,
): string {
  return secret ? `${classroom}/${encodeURIComponent(secret)}` : classroom
}

// generateSecret returns a cryptographically random secret of `length` chars
// from SECRET_ALPHABET, using rejection sampling to avoid the modulo bias a
// naive `byte % 36` would introduce (matches the CLI's generator).
export function generateSecret(length: number = DEFAULT_SECRET_LENGTH): string {
  if (length <= 0) {
    throw new Error(`secret length must be positive, got ${length}`)
  }
  const alphabetLen = SECRET_ALPHABET.length
  // Largest multiple of the alphabet size that fits in a byte; bytes >= this
  // would bias the low residues, so reject and redraw.
  const max = 256 - (256 % alphabetLen)
  const out: string[] = []
  const buf = new Uint8Array(1)
  while (out.length < length) {
    crypto.getRandomValues(buf)
    if (buf[0] >= max) continue
    out.push(SECRET_ALPHABET[buf[0] % alphabetLen])
  }
  return out.join("")
}
