import type { Student } from "@/types/classroom"
import { STAFF_ROLES, type StaffRole } from "@/types/classroom"
import type { GitHubUser, GitHubOrgInvitation } from "@/hooks/github/types"
import { rosterClaimSet } from "@/util/identity"

// Team-driven roster: the classroom GitHub team is the source of truth for
// enrollment and role, not roster.csv. Enrolled/pending rows come from team
// members + pending invitations; roster.csv enriches them (name/section/email)
// and never decides a person's role. A roster.csv row for someone on no team
// and with no pending invite still surfaces — but as a "needs attention" row
// (no role) so the teacher can act, split by whether they are an org member.
//
// Row states:
//  - enrolled: an active classroom-team / staff-team member.
//  - pending:  a pending org / staff-team invitation (no active membership yet).
//  - needs_attention_in_org: on roster.csv, an active org member, but on none of
//    this classroom's teams — the teacher assigns them a team/role.
//  - needs_attention_not_in_org: on roster.csv, NOT an org member and no pending
//    invite — the teacher invites them to the org.
//
// The two needs-attention states require org membership to be known. When it
// isn't (a non-owner who can't read members, or the read failed), those rows
// are suppressed rather than misclassified — the roster degrades to the pure
// team-driven view. Bulk CSV upload still sends org invites so uploaded students
// appear as `pending` rather than lingering as needs-attention.

export type TeamRosterRowState =
  | "enrolled"
  | "pending"
  | "needs_attention_in_org"
  | "needs_attention_not_in_org"

// A person's classroom role(s). "student" = classroom team; "instructor"/"ta"
// = the per-classroom staff teams. A person can hold several (an instructor
// also on the student team), so a row carries a set, unioned across teams.
export type RosterRole = StaffRole | "student"

// Precedence for the primary badge / role sort: instructor > ta > student.
// Exported so the shared role-presentation module (rosterRoles) re-exports it
// rather than defining a second copy.
export const ROLE_RANK: Record<RosterRole, number> = {
  instructor: 2,
  ta: 1,
  student: 0,
}

// The GitHub org membership role an invite/role-change carries for a classroom
// role: an instructor becomes an org OWNER ("admin"); student/ta are plain
// members. One source for this security-sensitive mapping (who gets org owner)
// so a missed hand-copy can't silently mis-scope admin access.
export function orgRoleForRole(role: RosterRole): "admin" | "direct_member" {
  return role === "instructor" ? "admin" : "direct_member"
}

// Inverse of orgRoleForRole: the classroom role implied by a GitHub org
// membership role on an existing invitation. "admin" means the invite grants
// org OWNER, i.e. an instructor; anything else re-invites as a plain student
// (org role alone can't distinguish TA from student, and student is the safe
// default a re-invite lands on — a TA re-invite would just be re-assigned).
export function roleForOrgRole(orgRole: string): RosterRole {
  return orgRole === "admin" ? "instructor" : "student"
}

export type TeamRosterRow = {
  // Stable identity for React keys and joins: github_id || login || email.
  // Mirrors studentKey.
  key: string
  state: TeamRosterRowState
  // Classroom role(s) this person holds, unioned across the student + staff
  // teams. Never empty (a plain student is ["student"]), sorted by ROLE_RANK.
  // For a needs-attention row the team hasn't assigned a role yet, so this holds
  // the placeholder ["student"] purely for the non-empty invariant — the view
  // renders NO role badge for those states.
  roles: RosterRole[]
  // GitHub identity when known. Empty only for an email-only pending invite.
  username: string
  github_id: string
  // Display metadata joined from the roster (blank when absent).
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
  // Active members of the per-classroom staff teams, keyed by role. Merged into
  // the same rows as `members` (a person on both the student and instructor
  // team is one enrolled row with roles ["instructor","student"]).
  staffMembers?: Partial<Record<StaffRole, GitHubUser[]>>
  // Pending team invitations for the staff teams, keyed by role. Team-scoped, so
  // a pending row is tagged with the role whose team lists it.
  staffInvitations?: Partial<Record<StaffRole, GitHubOrgInvitation[]>>
  // Optional roster.csv rows (display metadata only — they enrich team/invite
  // rows; a CSV row on no team surfaces as a needs-attention row, never with a
  // role).
  students: Student[]
  // Active org-member identity sets (ids + lowercased logins) used to split a
  // CSV row on no team into needs_attention_in_org (an org member) vs
  // needs_attention_not_in_org (not in the org). Build from the org-member list.
  orgMemberIds?: ReadonlySet<string>
  orgMemberLogins?: ReadonlySet<string>
  // Whether org membership was actually readable this render (an owner whose
  // member list loaded). When false (non-owner or a failed/forbidden read),
  // needs-attention rows are SUPPRESSED — the classifier has no basis, so the
  // roster degrades to the pure team-driven view rather than guessing.
  orgMembersKnown?: boolean
  // True when pending invitations are hidden (a non-owner can't read them, so
  // the caller passed invitations: [] / staffInvitations: {}). Without the
  // pending list the needs-attention classifier can't tell a genuinely
  // not-in-org CSV row from one whose only signal is a now-hidden pending
  // invite, so the whole needs-attention pass is suppressed to avoid mislabeling
  // a pending person as needs_attention_not_in_org.
  pendingHidden?: boolean
}

// Compute the team-driven roster. Members -> enrolled; pending invitations not
// already a member -> pending. A roster.csv row for someone on no team and with
// no pending invite -> a needs-attention row (in-org vs not-in-org by the
// org-member sets), emitted only when orgMembersKnown. roster.csv otherwise only
// ENRICHES team/invite rows (name / section / email). Never duplicates a person.
export function buildTeamRoster(input: BuildTeamRosterInput): TeamRosterRow[] {
  const {
    members,
    invitations = [],
    staffMembers = {},
    staffInvitations = {},
    students,
    orgMemberIds,
    orgMemberLogins,
    orgMembersKnown = false,
    pendingHidden = false,
  } = input
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
  // Logins of ACTIVE members only. A pending invite for one of these is stale
  // (already enrolled) and skipped — distinct from a login already claimed by
  // another PENDING invite, which must instead union its role onto that pending
  // row. Adding a not-yet-org-member to a staff team lists the same person in
  // BOTH the org-level invitations (tagged student) and the team invitations
  // (tagged ta/instructor); keying only on member logins would drop the second.
  const memberLogins = new Set<string>()
  // Enrolled rows already emitted, keyed by member id, so a person on several
  // teams gets one row with their roles unioned rather than duplicate rows.
  const enrolledById = new Map<string, TeamRosterRow>()
  // Pending rows already emitted, keyed by login (else email), for the same
  // union across the student + staff team invitation lists.
  const pendingByKey = new Map<string, TeamRosterRow>()

  // Members tagged with the role of the team they came from. The student team
  // is "student"; each staff team its role. Student first so a student+staff
  // person keeps their student metadata join, with staff roles unioned on.
  const roleMembers: Array<{ role: RosterRole; member: GitHubUser }> = [
    ...members.map((member) => ({ role: "student" as const, member })),
    ...STAFF_ROLES.flatMap((role) =>
      (staffMembers[role] ?? []).map((member) => ({ role, member })),
    ),
  ]

  for (const { role, member } of roleMembers) {
    const id = String(member.id)
    const existing = enrolledById.get(id)
    if (existing) {
      addRole(existing, role)
      continue
    }
    const login = member.login.toLowerCase()
    memberLogins.add(login)
    const own = csvForMember(csv, member)
    const email = own?.email?.trim().toLowerCase()
    const row: TeamRosterRow = {
      key: id,
      state: "enrolled",
      roles: [role],
      username: member.login,
      github_id: id,
      avatar_url: member.avatar_url,
      ...metadataFrom(own, legacyFor(email)),
    }
    enrolledById.set(id, row)
    rows.push(row)
  }

  // Pending, tagged by role. Staff-team invitations are AUTHORITATIVE for a
  // staff role and are processed FIRST: adding a not-yet-org-member to a staff
  // team lists them in BOTH the team invitations (tagged ta/instructor) AND the
  // org-level invitations (which we can only blanket-tag "student"). Ordering
  // staff first lets the org-level "student" invite recognize the person as an
  // already-tagged pending staffer and NOT add a spurious "student" role.
  const roleInvites: Array<{
    role: RosterRole
    invite: GitHubOrgInvitation
  }> = [
    ...STAFF_ROLES.flatMap((role) =>
      (staffInvitations[role] ?? []).map((invite) => ({ role, invite })),
    ),
    ...invitations.map((invite) => ({ role: "student" as const, invite })),
  ]

  for (const { role, invite } of roleInvites) {
    const login = invite.login?.trim() ?? ""
    const loginKey = login.toLowerCase()
    const email = invite.email?.trim() ?? ""
    const emailKey = email.toLowerCase()
    // A login-carrying invite for an account already an ACTIVE member is stale
    // — skip. (A login already claimed by another PENDING invite is NOT stale:
    // it falls through to the pendingByKey union below so its role is added.)
    // Email-only invites can't collide with a member here.
    if (loginKey && memberLogins.has(loginKey)) continue

    const dedupeKey = loginKey || emailKey || `id:${invite.id}`
    const existingPending = pendingByKey.get(dedupeKey)
    if (existingPending) {
      // A staffer already pending: the org-level list re-reports them as a
      // generic invite, but they aren't a student — don't add the "student"
      // role. A genuine multi-team pending (e.g. instructor + ta) still unions.
      if (role !== "student") addRole(existingPending, role)
      continue
    }

    // Join CSV metadata by login first, then email.
    const own =
      (loginKey ? csv.byLogin.get(loginKey) : undefined) ??
      (emailKey ? csv.byEmail.get(emailKey) : undefined)

    const row: TeamRosterRow = {
      key: login || email || String(invite.id),
      state: "pending",
      roles: [role],
      username: login,
      github_id: own?.github_id?.trim() ?? "",
      avatar_url: "",
      invitation_id: invite.id,
      ...metadataFrom(own, legacyFor(emailKey || own?.email)),
      // Prefer the row's own email; fall back to the invite's target email.
      email: own?.email?.trim() || email,
    }
    pendingByKey.set(dedupeKey, row)
    rows.push(row)
  }

  // Needs-attention pass: a roster.csv row for someone on none of this
  // classroom's teams and with no pending invite. Emitted only when org
  // membership is known (else suppressed — see orgMembersKnown). Split by real
  // org membership: an org member is needs_attention_in_org (assign a team);
  // a non-member is needs_attention_not_in_org (invite). No role is asserted —
  // the team is the authority — so roles carries the ["student"] placeholder for
  // the non-empty invariant and the view renders no role badge for these states.
  if (orgMembersKnown && !pendingHidden) {
    const pendingLogins = new Set<string>()
    const pendingEmails = new Set<string>()
    for (const row of pendingByKey.values()) {
      const l = row.username.trim().toLowerCase()
      const e = row.email.trim().toLowerCase()
      if (l) pendingLogins.add(l)
      if (e) pendingEmails.add(e)
    }
    // A duplicate CSV row for the same person must not emit twice.
    const seenIds = new Set<string>()
    const seenLogins = new Set<string>()
    for (const student of students) {
      const id = student.github_id?.trim() ?? ""
      const login = student.username?.trim() ?? ""
      const loginKey = login.toLowerCase()
      const email = student.email?.trim().toLowerCase() ?? ""
      // A row must carry a GitHub identity to appear on its own; a legacy
      // email-only row only enriches (handled above).
      if (!id && !loginKey) continue
      // Already an enrolled member or a pending invite?
      if (id && enrolledById.has(id)) continue
      if (loginKey && memberLogins.has(loginKey)) continue
      if (loginKey && pendingLogins.has(loginKey)) continue
      if (email && pendingEmails.has(email)) continue
      // Dedupe duplicate CSV rows for the same person.
      if (id && seenIds.has(id)) continue
      if (loginKey && seenLogins.has(loginKey)) continue
      if (id) seenIds.add(id)
      if (loginKey) seenLogins.add(loginKey)

      const inOrg =
        (id && orgMemberIds?.has(id)) ||
        (loginKey && orgMemberLogins?.has(loginKey)) ||
        false
      rows.push({
        key: id || login,
        state: inOrg ? "needs_attention_in_org" : "needs_attention_not_in_org",
        roles: ["student"],
        username: login,
        github_id: id,
        avatar_url: "",
        ...metadataFrom(student, legacyFor(email)),
      })
    }
  }

  return sortRows(rows)
}

// Add a role to a row's set (idempotent), keeping ROLE_RANK order.
function addRole(row: TeamRosterRow, role: RosterRole): void {
  if (row.roles.includes(role)) return
  row.roles = sortRolesByRank([...row.roles, role])
}

// Sort a role set by precedence (highest first). Pure; returns a new array.
// Lives here beside ROLE_RANK (its only dependency) so the rank comparator has
// a single home; rosterRoles re-exports it for UI callers.
export function sortRolesByRank(roles: RosterRole[]): RosterRole[] {
  return [...roles].sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])
}

// Display name for sorting: "Last, First" folded to a comparable string, else
// username, else email.
function sortName(row: TeamRosterRow): string {
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ")
  return (name || row.username || row.email).toLowerCase()
}

// Enrolled first, then pending, then needs-attention; alphabetical within each.
function sortRows(rows: TeamRosterRow[]): TeamRosterRow[] {
  const order: Record<TeamRosterRowState, number> = {
    enrolled: 0,
    pending: 1,
    needs_attention_in_org: 2,
    needs_attention_not_in_org: 3,
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
    // Primary (highest-precedence) role as recorded metadata. roles is always
    // non-empty and rank-sorted (instructor > ta > student).
    role: row.roles[0],
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
    {
      enrolled: 0,
      pending: 0,
      needs_attention_in_org: 0,
      needs_attention_not_in_org: 0,
    } as Record<TeamRosterRowState, number>,
  )
}

// Team members with NO roster.csv row — the exact set syncRosterFromTeam
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

// CSV rows that already exist but are STALE against team membership: the person
// is on a classroom team (matched by id, then login — the same join sync uses),
// yet the row's github_id is blank or its recorded role differs from the team's
// primary role. These need the same server-side backfill sync performs, but
// they aren't "missing" (teamMembersMissingFromCsv skips them because their
// login/id is claimed), so the drift trigger would otherwise never fire for a
// login-only row like `student1,,,,,,`. `staffMembers` is keyed by role so the
// primary role can be derived (instructor > ta > student). Pure + testable.
export function rowsNeedingBackfill(
  members: GitHubUser[],
  staffMembers: Partial<Record<StaffRole, GitHubUser[]>>,
  students: Student[],
): Student[] {
  // Primary team role per id and per login (highest precedence wins).
  const roleById = new Map<string, RosterRole>()
  const roleByLogin = new Map<string, RosterRole>()
  const consider = (m: GitHubUser, role: RosterRole) => {
    const id = String(m.id)
    const login = m.login.toLowerCase()
    if (!roleById.has(id) || ROLE_RANK[role] > ROLE_RANK[roleById.get(id)!]) {
      roleById.set(id, role)
    }
    if (
      !roleByLogin.has(login) ||
      ROLE_RANK[role] > ROLE_RANK[roleByLogin.get(login)!]
    ) {
      roleByLogin.set(login, role)
    }
  }
  for (const m of members) consider(m, "student")
  for (const role of STAFF_ROLES) {
    for (const m of staffMembers[role] ?? []) consider(m, role)
  }

  return students.filter((s) => {
    const id = s.github_id?.trim()
    const login = s.username?.trim().toLowerCase()
    const teamRole =
      (id ? roleById.get(id) : undefined) ??
      (login ? roleByLogin.get(login) : undefined)
    // Not on any team -> nothing for sync to backfill (a needs-attention row).
    if (!teamRole) return false
    // On a team but the id is blank, or the recorded role is stale.
    return !id || s.role !== teamRole
  })
}
