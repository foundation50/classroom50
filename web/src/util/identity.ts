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
// disagrees. That stays deliberately permissive because every caller uses the
// result to REFUSE or SKIP a destructive, hard-to-reverse action (self-demotion,
// self-removal, demoting the sole org owner, cancelling a pending org invite):
// an over-match only declines the action, while a missed match carries it out.
// A caller needing positive identification should match on id alone instead.
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

// Parse a roster row's github_id into a positive numeric id, else null. Accepts
// only a plain digit string: `Number()` alone would coerce a malformed cell like
// "1e3" or "0x10" into a valid-LOOKING id (1000, 16) that callers then send as
// `invitee_id`, inviting a stranger into the org. Rejecting is safe — callers
// either refuse, skip the row, or re-resolve the id from the login.
export function parseGitHubId(githubId: string): number | null {
  if (!/^\d+$/.test(githubId.trim())) return null
  const id = Number(githubId)
  return Number.isSafeInteger(id) && id > 0 ? id : null
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
