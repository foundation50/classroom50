import type { Student } from "@/types/classroom"
import type { GitHubUser, GitHubOrgInvitation } from "@/hooks/github/types"
import { rosterClaimSet } from "@/util/identity"

// Team-driven roster: the classroom GitHub team is the source of truth for who
// belongs, not students.csv. The roster is computed PURELY from team members +
// pending org invitations, then enriched with optional students.csv metadata
// (name/section/email). The CSV never decides enrollment — it can be absent or
// partial and the roster still renders.
//
// Every students.csv row now carries a GitHub identity (username, ideally with
// github_id). Legacy username-less rows (e.g. old email-only invite stubs) are
// IGNORED for classification; their name/section is only borrowed to enrich a
// username/id row that shares the same email (the one legacy merge we keep).
//
// Row states:
//  - enrolled:   an active classroom-team / org member.
//  - pending:    a pending org invitation (no active membership yet).
//  - not_in_org: a CSV row WITH a GitHub username that is neither a team/org
//                member nor a pending invite — on the roster but not in the
//                organization. Always tied to a username so it persists
//                reliably. Kept VISIBLE so a rostered student is never lost.
//
// "drift" is folded into `not_in_org`; its count drives the banner.

export type TeamRosterRowState = "enrolled" | "pending" | "not_in_org"

export type TeamRosterRow = {
  // Stable identity for React keys and joins: github_id || login || email.
  // Mirrors studentKey.
  key: string
  state: TeamRosterRowState
  // GitHub identity when known. Empty only for an email-only pending invite.
  username: string
  github_id: string
  // Display metadata joined from students.csv (blank when absent).
  first_name: string
  last_name: string
  section: string
  email: string
  avatar_url: string
  // Pending org-invitation id, set only for `pending` rows. Threaded to
  // resendOrgInvitation, which short-circuits without it.
  invitation_id?: number
}

// A CSV row keyed for the fallback join: github_id, then lowercased username,
// then lowercased email. The same fallback chain (github_id -> username) keeps
// a pre-resolution row with an empty github_id from being misclassified as
// drift or causing a duplicate backfill. Exported so aggregateOrgMembers
// reconciles team-vs-CSV with the SAME join, so the two views can't disagree.
export type CsvIndex = {
  byGithubId: Map<string, Student>
  byLogin: Map<string, Student>
  byEmail: Map<string, Student>
}

export function indexCsv(students: Student[]): CsvIndex {
  const byGithubId = new Map<string, Student>()
  const byLogin = new Map<string, Student>()
  const byEmail = new Map<string, Student>()
  for (const s of students) {
    const id = s.github_id?.trim()
    const login = s.username?.trim().toLowerCase()
    const email = s.email?.trim().toLowerCase()
    if (id && !byGithubId.has(id)) byGithubId.set(id, s)
    if (login && !byLogin.has(login)) byLogin.set(login, s)
    if (email && !byEmail.has(email)) byEmail.set(email, s)
  }
  return { byGithubId, byLogin, byEmail }
}

// Find the CSV row for a GitHub account, github_id first then login.
export function csvForMember(
  index: CsvIndex,
  member: { id: number; login: string },
): Student | undefined {
  return (
    index.byGithubId.get(String(member.id)) ??
    index.byLogin.get(member.login.toLowerCase())
  )
}

// Metadata for a row, merging the row's own CSV student with an optional legacy
// (email-only) fallback per field: the row's own value wins; a blank field
// borrows from the legacy row. email is always the row's own (never borrowed).
const metadataFrom = (
  student: Student | undefined,
  legacy?: Student | undefined,
) => ({
  first_name: (student?.first_name?.trim() || legacy?.first_name?.trim()) ?? "",
  last_name: (student?.last_name?.trim() || legacy?.last_name?.trim()) ?? "",
  section: (student?.section?.trim() || legacy?.section?.trim()) ?? "",
  email: student?.email?.trim() ?? "",
})

export type BuildTeamRosterInput = {
  // Active classroom-team / org members (the enrolled source of truth).
  members: GitHubUser[]
  // Pending org invitations. May be empty for a non-owner who can't read them
  // (owner-only endpoint) — enrolled rows still render.
  invitations?: GitHubOrgInvitation[]
  // Optional students.csv rows (display metadata only).
  students: Student[]
}

// Compute the team-driven roster. Members -> enrolled; pending invitations not
// already a member -> pending; CSV rows WITH a username that are neither ->
// not_in_org. Username-less CSV rows (legacy email-only stubs) never produce a
// row; their name/section is merged into a username/id row sharing their email.
// Never duplicates a person (a member on the CSV appears once; a username-invite
// that is also a member is credited as the member).
export function buildTeamRoster(input: BuildTeamRosterInput): TeamRosterRow[] {
  const { members, invitations = [], students } = input
  const csv = indexCsv(students)

  // Legacy username-less rows indexed by email, to enrich a real (username or
  // id-carrying) row that shares the email. This is the ONLY use of email-only
  // rows — they never render on their own.
  const legacyByEmail = new Map<string, Student>()
  for (const s of students) {
    const hasIdentity = Boolean(s.github_id?.trim() || s.username?.trim())
    const email = s.email?.trim().toLowerCase()
    if (!hasIdentity && email && !legacyByEmail.has(email)) {
      legacyByEmail.set(email, s)
    }
  }

  // A legacy email-only row (name/section donor) for a given email, if any.
  const legacyFor = (email: string | undefined): Student | undefined =>
    email ? legacyByEmail.get(email.toLowerCase()) : undefined

  const rows: TeamRosterRow[] = []
  // Track emitted identities so invites/CSV don't double up.
  const seenIds = new Set<string>()
  const seenLogins = new Set<string>()

  for (const member of members) {
    const id = String(member.id)
    const login = member.login.toLowerCase()
    seenIds.add(id)
    seenLogins.add(login)
    const own = csvForMember(csv, member)
    const email = own?.email?.trim().toLowerCase()
    rows.push({
      key: id,
      state: "enrolled",
      username: member.login,
      github_id: id,
      avatar_url: member.avatar_url,
      ...metadataFrom(own, legacyFor(email)),
    })
  }

  for (const invite of invitations) {
    const login = invite.login?.trim() ?? ""
    const loginKey = login.toLowerCase()
    const email = invite.email?.trim() ?? ""
    const emailKey = email.toLowerCase()
    // A login-carrying invite for an account already a member is stale — skip.
    // Email-only invites can't collide with a member here.
    if (loginKey && seenLogins.has(loginKey)) continue

    // Join CSV metadata by login first, then email.
    const own =
      (loginKey ? csv.byLogin.get(loginKey) : undefined) ??
      (emailKey ? csv.byEmail.get(emailKey) : undefined)

    if (loginKey) seenLogins.add(loginKey)
    rows.push({
      key: login || email || String(invite.id),
      state: "pending",
      username: login,
      github_id: own?.github_id?.trim() ?? "",
      avatar_url: "",
      invitation_id: invite.id,
      ...metadataFrom(own, legacyFor(emailKey || own?.email)),
      // Prefer the row's own email; fall back to the invite's target email.
      email: own?.email?.trim() || email,
    })
  }

  for (const student of students) {
    const id = student.github_id?.trim() ?? ""
    const login = student.username?.trim().toLowerCase() ?? ""
    const email = student.email?.trim().toLowerCase() ?? ""
    // A row must carry a GitHub identity to appear on its own. Legacy
    // username-less rows are ignored here (only used to enrich by email above).
    if (!id && !login) continue
    // Already an enrolled member or a pending invite?
    if (id && seenIds.has(id)) continue
    if (login && seenLogins.has(login)) continue
    // Mark seen so duplicate CSV rows for the same person don't both emit.
    if (id) seenIds.add(id)
    if (login) seenLogins.add(login)
    rows.push({
      key: student.github_id || student.username,
      state: "not_in_org",
      username: student.username?.trim() ?? "",
      github_id: id,
      avatar_url: "",
      ...metadataFrom(student, legacyFor(email)),
    })
  }

  return sortRows(rows)
}

// Display name for sorting: "Last, First" folded to a comparable string, else
// username, else email.
function sortName(row: TeamRosterRow): string {
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ")
  return (name || row.username || row.email).toLowerCase()
}

// Enrolled first, then pending, then not_in_org; alphabetical within each.
function sortRows(rows: TeamRosterRow[]): TeamRosterRow[] {
  const order: Record<TeamRosterRowState, number> = {
    enrolled: 0,
    pending: 1,
    not_in_org: 2,
  }
  return rows.sort((a, b) => {
    const byState = order[a.state] - order[b.state]
    if (byState !== 0) return byState
    return sortName(a).localeCompare(sortName(b), undefined, { numeric: true })
  })
}

// Project a roster row back to the display-metadata Student shape the grade
// dashboard consumes. Single-sourced here so callers can't drift on the field
// list — a new Student field surfaces as a type error rather than a dropped
// column at each call site.
export function rowToStudent(row: TeamRosterRow): Student {
  return {
    username: row.username,
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    section: row.section,
    github_id: row.github_id,
  }
}

// Convenience accessors the view uses for section counts / banners.
export function countByState(
  rows: TeamRosterRow[],
): Record<TeamRosterRowState, number> {
  return rows.reduce(
    (acc, row) => {
      acc[row.state] += 1
      return acc
    },
    { enrolled: 0, pending: 0, not_in_org: 0 } as Record<
      TeamRosterRowState,
      number
    >,
  )
}

// Team members with NO students.csv row — the exact set syncRosterFromTeam
// appends. "Missing" when their id, login, AND profile email are all unclaimed
// by any CSV row (the same id -> login -> email join syncRosterFromTeam uses,
// so this count and the write can't diverge). Drives the "Sync roster" button
// and auto-sync-on-open. Pure so it's testable before deciding to write.
export function teamMembersMissingFromCsv(
  members: GitHubUser[],
  students: Student[],
): GitHubUser[] {
  const { ids, logins } = rosterClaimSet(students)
  const emails = new Set(
    students
      .map((s) => s.email?.trim().toLowerCase())
      .filter((e): e is string => Boolean(e)),
  )
  return members.filter(
    (m) =>
      !ids.has(String(m.id)) &&
      !logins.has(m.login.toLowerCase()) &&
      !(m.email ? emails.has(m.email.trim().toLowerCase()) : false),
  )
}

// The rostered usernames that are `not_in_org` — on students.csv with a GitHub
// username but neither a team/org member nor a pending invite. Auto-reconcile
// feeds these straight to reconcileTeamFromOrgMembers, which team-adds the ones
// that turn out to be active org members and skips the rest (they stay
// `not_in_org`, highlighted for the teacher to invite or remove). The CSV
// username is authoritative — the teacher owns its accuracy — so no reverse
// match against the live org-member list (which could target a recycled login
// on the wrong account) is needed.
export function notInOrgUsernames(rows: TeamRosterRow[]): string[] {
  return rows
    .filter((r) => r.state === "not_in_org")
    .map((r) => r.username.trim())
    .filter(Boolean)
}
