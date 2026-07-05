import type { GitHubUser } from "@/hooks/github/types"

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

// Parse a roster row's github_id into a positive numeric id, else null. GitHub
// ids are positive integers; the CSV stores them as strings.
export function parseGitHubId(githubId: string): number | null {
  const id = Number(githubId)
  return Number.isFinite(id) && id > 0 ? id : null
}

// String github_ids of the org's live members — member-status classification
// and the "Mark enrolled" gate match a roster row's github_id against these.
export function memberIdSet(members: GitHubUser[]): Set<string> {
  return new Set(members.map((member) => String(member.id)))
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
