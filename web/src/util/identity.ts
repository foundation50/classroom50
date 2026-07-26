import type { GitHubUser } from "@/github-core/types"

// Canonical identity helpers relating GitHub accounts, org members, and roster
// rows — one home so id/login/"claimed" logic can't drift across callers.

// Stable, position-independent per-row identity: github_id (survives rename),
// then username, then email. Rows always carry one (parseStudentsCsv drops
// fully-empty rows), so no index fallback is needed.
export function studentKey(student: {
  github_id?: string
  username?: string
  email?: string
}): string {
  return student.github_id || student.username || student.email || ""
}

// Whether a GitHub account is the same person as a roster student: numeric id
// first, then case-insensitive login (the CSV may predate id capture).
//
// The checks are OR'd, so a login match wins even when a captured github_id
// disagrees. Deliberately permissive: callers use this to REFUSE or SKIP a
// destructive action, so an over-match only declines it while a missed match
// carries it out. Match on id alone if you need positive identification.
export function isSameGitHubUser(
  account: { id: number; login: string } | null | undefined,
  student: { github_id?: string; username: string },
): boolean {
  if (!account) return false
  return (
    String(account.id) === String(student.github_id) ||
    account.login.toLowerCase() === student.username.trim().toLowerCase()
  )
}

// Whether a github_id cell is spelled the way this app stores one: a canonical
// digit string. `Number()` alone would coerce a malformed cell like "1e3" or
// "0x10" into a valid-LOOKING id (1000, 16) that callers then send as
// `invitee_id`, inviting a stranger into the org.
//
// This is the JOIN predicate, so a leading zero is rejected even though it
// parses: `String(member.id)` is never padded and the id-keyed joins
// (memberIdSet, rosterClaimSet, and the membership/"Mark enrolled"
// comparisons) match the RAW cell, so "0583231" would read as unenrolled
// forever. Use resolveGitHubId to act on such a cell.
export function parseGitHubId(githubId: string): number | null {
  const trimmed = githubId.trim()
  if (!/^[1-9]\d*$/.test(trimmed)) return null
  const id = Number(trimmed)
  return Number.isSafeInteger(id) ? id : null
}

// The account a github_id cell addresses, tolerating a non-canonical spelling
// the join predicate refuses. Only leading zeros are tolerated — "0583231" and
// "583231" are the same account, unambiguously.
//
// Callers taking an ACTION (invite, resend, enroll) want this one: the
// alternative is falling back to the mutable login, which after a rename can
// carry repo access to whoever took the freed login. Mirrors the Go reader,
// which resolves the same cells and rewrites them canonically on the next
// write, so both tools converge on the account rather than on the spelling.
export function resolveGitHubId(githubId: string | undefined): number | null {
  return parseGitHubId((githubId ?? "").trim().replace(/^0+(?=\d)/, ""))
}

// A github_id that is present but not canonical (see parseGitHubId).
// Distinguished from a blank one because a corrupted cell needs a different
// remedy than an absent one ("re-add them to the roster" would not fix it).
export function isMalformedGitHubId(githubId: string | undefined): boolean {
  const trimmed = githubId?.trim() ?? ""
  return trimmed !== "" && parseGitHubId(trimmed) === null
}

// String github_ids of the org's live members — member-status classification
// and the "Mark enrolled" gate match a roster row's github_id against these.
export function memberIdSet(members: GitHubUser[]): Set<string> {
  return new Set(members.map((member) => String(member.id)))
}

// Both identity sets for a GitHub member list: string github_ids and lowercased
// logins. The id/login pair is the canonical way to test "is this account one
// of these members?" (id survives a rename; login covers a pre-id record), so
// callers classifying a roster row against org/team membership share one fold
// rather than re-deriving the two sets inline.
export function memberIdentitySets(members: GitHubUser[]): {
  ids: Set<string>
  logins: Set<string>
} {
  const ids = new Set<string>()
  const logins = new Set<string>()
  for (const member of members) {
    ids.add(String(member.id))
    logins.add(member.login.toLowerCase())
  }
  return { ids, logins }
}

// GitHub ids and lowercased logins already claimed by a roster; a member is
// "claimed" when their id or login appears on any row. Shared so org-members
// aggregation and the team-sync "missing member" join apply one predicate.
export function rosterClaimSet(
  students: { github_id?: string; username?: string }[],
): {
  ids: Set<string>
  logins: Set<string>
} {
  const ids = new Set<string>()
  const logins = new Set<string>()
  for (const student of students) {
    const id = student.github_id?.trim()
    const login = student.username?.trim().toLowerCase()
    if (id) ids.add(id)
    if (login) logins.add(login)
  }
  return { ids, logins }
}
