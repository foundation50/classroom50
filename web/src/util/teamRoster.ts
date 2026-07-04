import type { Student } from "@/types/classroom"
import type { GitHubUser, GitHubOrgInvitation } from "@/hooks/github/types"

// Team-driven roster: the classroom GitHub team is the source of truth for who
// belongs, not students.csv. This module computes the teacher-facing roster
// PURELY from team members + pending org invitations, then enriches each row
// with optional students.csv metadata (name/section/email). The CSV never
// decides enrollment — it can be absent or partial and the roster still renders.
//
// Row states:
//  - enrolled:     an active classroom-team / org member.
//  - pending:      a pending org invitation (no active membership yet).
//  - unprovisioned: on students.csv but NOT a team member and NOT a pending
//                   invite — e.g. a rostered student who can't yet form
//                   membership (not yet IdP/SSO-provisioned). Kept VISIBLE as a
//                   distinct state so a student the teacher trusts never
//                   silently disappears (decided over hiding-behind-drift).
//
// "drift" in this model is folded into `unprovisioned` (a CSV row with no
// matching member/invite); the count of unprovisioned rows drives the banner.

export type TeamRosterRowState = "enrolled" | "pending" | "unprovisioned"

export type TeamRosterRow = {
  // Stable identity for React keys and joins: github_id (member) || login ||
  // email (invite/CSV-only). Mirrors studentKey.
  key: string
  state: TeamRosterRowState
  // GitHub identity when known (member or username-invite). Empty for an
  // email-only pending invite or an email-only CSV row.
  username: string
  github_id: string
  // Display metadata joined from students.csv (blank when absent).
  first_name: string
  last_name: string
  section: string
  email: string
  avatar_url: string
  // The pending org-invitation id, set only for `pending` rows. Threaded to
  // resendOrgInvitation so a still-pending invite is actually recreated (a
  // resend without it short-circuits and re-sends nothing).
  invitation_id?: number
}

// A CSV row keyed for the fallback join: github_id first, then lowercased
// username, then lowercased email. Section 4/5 require the SAME fallback chain
// (github_id -> username) so an imported/hand-edited/pre-resolution row with an
// empty github_id isn't misclassified as drift AND doesn't cause the backfill
// to append a duplicate.
type CsvIndex = {
  byGithubId: Map<string, Student>
  byLogin: Map<string, Student>
  byEmail: Map<string, Student>
}

function indexCsv(students: Student[]): CsvIndex {
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
function csvForMember(
  index: CsvIndex,
  member: { id: number; login: string },
): Student | undefined {
  return (
    index.byGithubId.get(String(member.id)) ??
    index.byLogin.get(member.login.toLowerCase())
  )
}

const metadataFrom = (student: Student | undefined) => ({
  first_name: student?.first_name?.trim() ?? "",
  last_name: student?.last_name?.trim() ?? "",
  section: student?.section?.trim() ?? "",
  email: student?.email?.trim() ?? "",
})

export type BuildTeamRosterInput = {
  // Active classroom-team / org members (the enrolled source of truth).
  members: GitHubUser[]
  // Pending org invitations. May be empty/omitted for a non-owner who can't
  // read them (owner-only endpoint) — the roster still renders enrolled rows.
  invitations?: GitHubOrgInvitation[]
  // Optional students.csv rows (display metadata only).
  students: Student[]
}

// Compute the team-driven roster. Members -> enrolled; pending invitations that
// don't correspond to an already-counted member -> pending; students.csv rows
// with no matching member or invite -> unprovisioned. Never returns duplicates
// for the same person (a member on the CSV appears once; a username-invite that
// is also a member is credited as the member).
export function buildTeamRoster(input: BuildTeamRosterInput): TeamRosterRow[] {
  const { members, invitations = [], students } = input
  const csv = indexCsv(students)

  const rows: TeamRosterRow[] = []
  // Track which identities we've already emitted so invites/CSV don't double up.
  const seenIds = new Set<string>()
  const seenLogins = new Set<string>()
  const seenEmails = new Set<string>()

  // 1. Members -> enrolled.
  for (const member of members) {
    const id = String(member.id)
    const login = member.login.toLowerCase()
    seenIds.add(id)
    seenLogins.add(login)
    const student = csvForMember(csv, member)
    const email = student?.email?.trim().toLowerCase()
    if (email) seenEmails.add(email)
    rows.push({
      key: id,
      state: "enrolled",
      username: member.login,
      github_id: id,
      avatar_url: member.avatar_url,
      ...metadataFrom(student),
    })
  }

  // 2. Pending invitations -> pending (unless already an active member).
  for (const invite of invitations) {
    const login = invite.login?.trim() ?? ""
    const loginKey = login.toLowerCase()
    const email = invite.email?.trim() ?? ""
    const emailKey = email.toLowerCase()
    // A login-carrying invite for an account already counted as a member is
    // stale — skip it. Email-only invites can't collide with a member here.
    if (loginKey && seenLogins.has(loginKey)) continue

    // Join CSV metadata by login first, then email.
    const student =
      (loginKey ? csv.byLogin.get(loginKey) : undefined) ??
      (emailKey ? csv.byEmail.get(emailKey) : undefined)

    if (loginKey) seenLogins.add(loginKey)
    if (emailKey) seenEmails.add(emailKey)
    rows.push({
      key: login || email || String(invite.id),
      state: "pending",
      username: login,
      github_id: student?.github_id?.trim() ?? "",
      avatar_url: "",
      invitation_id: invite.id,
      ...metadataFrom(student),
    })
  }

  // 3. students.csv rows with no matching member or invite -> unprovisioned.
  for (const student of students) {
    const id = student.github_id?.trim() ?? ""
    const login = student.username?.trim().toLowerCase() ?? ""
    const email = student.email?.trim().toLowerCase() ?? ""
    // Already represented as an enrolled member or a pending invite?
    if (id && seenIds.has(id)) continue
    if (login && seenLogins.has(login)) continue
    if (email && seenEmails.has(email)) continue
    // Mark seen so duplicate CSV rows for the same person don't both emit.
    if (id) seenIds.add(id)
    if (login) seenLogins.add(login)
    if (email) seenEmails.add(email)
    rows.push({
      key: student.github_id || student.username || student.email,
      state: "unprovisioned",
      username: student.username?.trim() ?? "",
      github_id: id,
      avatar_url: "",
      ...metadataFrom(student),
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

// Enrolled first, then pending, then unprovisioned; alphabetical within each.
function sortRows(rows: TeamRosterRow[]): TeamRosterRow[] {
  const order: Record<TeamRosterRowState, number> = {
    enrolled: 0,
    pending: 1,
    unprovisioned: 2,
  }
  return rows.sort((a, b) => {
    const byState = order[a.state] - order[b.state]
    if (byState !== 0) return byState
    return sortName(a).localeCompare(sortName(b), undefined, { numeric: true })
  })
}

// Project a roster row back to the display-metadata Student shape the grade
// dashboard consumes. Single-sourced here (the row already carries every
// Student field) so callers can't drift on the field list — a new Student
// field surfaces as a type error here rather than a silently dropped column at
// each inline call site.
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
    { enrolled: 0, pending: 0, unprovisioned: 0 } as Record<
      TeamRosterRowState,
      number
    >,
  )
}
