import type { Student } from "@/types/classroom"
import type { GitHubUser } from "@/hooks/github/types"
import { memberIdSet, rosterClaimSet, studentKey } from "@/util/identity"

// One classroom a student appears on.
export type ClassroomAccess = {
  classroom: string
  archived: boolean
  section: string
}

// How an aggregated row relates org membership to roster presence:
//  - member-on-roster: a healthy member on >=1 roster.
//  - on-roster-not-member: the discrepancy this classification targets — on a roster but
//    no longer (or never) an org member.
//  - member-no-roster: an org member on no classroom roster (e.g. a co-teacher,
//    or a leftover after an unenroll).
export type MemberClassification =
  "member-on-roster" | "on-roster-not-member" | "member-no-roster"

export type OrgMemberRow = {
  // Stable identity, mirroring studentKey (github_id || username || email).
  key: string
  username: string
  github_id: string
  name: string
  email: string
  isMember: boolean
  classrooms: ClassroomAccess[]
  classification: MemberClassification
}

export type ClassroomRoster = {
  classroom: string
  archived: boolean
  students: Student[]
}

// Pick the better display name for the same student seen across rosters: prefer
// a row that carries a name over one that doesn't.
const fullName = (s: Student) =>
  [s.first_name, s.last_name]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")

// Deduplicate students across every roster (by studentKey), match each to a live
// org member by numeric github_id, fold in org members that appear on no roster,
// and classify every row. Pure so the dedupe/match/classify logic is testable
// without react-query. Members and rosters are matched on the SAME keys the
// per-classroom roster uses (studentKey / memberIdSet) so the two views agree.
export function aggregateOrgMembers(
  members: GitHubUser[],
  rosters: ClassroomRoster[],
): OrgMemberRow[] {
  const memberIds = memberIdSet(members)
  // Login -> numeric id, so a roster row that carries a username but no
  // github_id (typed before reconcile) can still be matched to a live member.
  // Without this, such a row is classified on-roster-not-member AND the member
  // is also emitted as member-no-roster — the same person counted twice.
  const memberIdByLogin = new Map<string, string>(
    members.map((m) => [m.login.toLowerCase(), String(m.id)]),
  )

  type Acc = {
    key: string
    username: string
    github_id: string
    name: string
    email: string
    classrooms: ClassroomAccess[]
  }
  const byKey = new Map<string, Acc>()

  for (const roster of rosters) {
    for (const student of roster.students) {
      const key = studentKey(student)
      if (!key) continue
      const access: ClassroomAccess = {
        classroom: roster.classroom,
        archived: roster.archived,
        section: student.section?.trim() ?? "",
      }
      const existing = byKey.get(key)
      if (existing) {
        existing.classrooms.push(access)
        if (!existing.username && student.username)
          existing.username = student.username
        if (!existing.github_id && student.github_id)
          existing.github_id = student.github_id
        if (!existing.email && student.email) existing.email = student.email
        const name = fullName(student)
        if (!existing.name && name) existing.name = name
      } else {
        byKey.set(key, {
          key,
          username: student.username ?? "",
          github_id: student.github_id ?? "",
          name: fullName(student),
          email: student.email ?? "",
          classrooms: [access],
        })
      }
    }
  }

  const rows: OrgMemberRow[] = []
  const matchedMemberIds = new Set<string>()

  for (const acc of byKey.values()) {
    // Match by github_id when present; otherwise fall back to login (a row that
    // hasn't been reconciled to an id yet). The resolved id is recorded in
    // matchedMemberIds so the no-roster fold below doesn't emit a duplicate row.
    const loginId = acc.username
      ? memberIdByLogin.get(acc.username.toLowerCase())
      : undefined
    const matchedId =
      acc.github_id && memberIds.has(acc.github_id)
        ? acc.github_id
        : (loginId ?? "")
    const isMember = Boolean(matchedId)
    if (isMember) matchedMemberIds.add(matchedId)
    rows.push({
      key: acc.key,
      username: acc.username,
      // Prefer the resolved live member id over a roster id: a stale CSV id that
      // matched a member only by login would otherwise be displayed/used.
      github_id: matchedId || acc.github_id,
      name: acc.name,
      email: acc.email,
      isMember,
      classrooms: acc.classrooms,
      classification: isMember ? "member-on-roster" : "on-roster-not-member",
    })
  }

  // Org members on no roster.
  for (const member of members) {
    const id = String(member.id)
    if (matchedMemberIds.has(id)) continue
    rows.push({
      key: id,
      username: member.login,
      github_id: id,
      name: member.name ?? "",
      email: member.email ?? "",
      isMember: true,
      classrooms: [],
      classification: "member-no-roster",
    })
  }

  // Discrepancies first (the actionable rows), then members, then by login/name.
  const order: Record<MemberClassification, number> = {
    "on-roster-not-member": 0,
    "member-on-roster": 1,
    "member-no-roster": 2,
  }
  rows.sort((a, b) => {
    const byClass = order[a.classification] - order[b.classification]
    if (byClass !== 0) return byClass
    return (a.username || a.name || a.email).localeCompare(
      b.username || b.name || b.email,
    )
  })

  return rows
}

// A candidate GitHub account for a teacher to manually match to an email-only
// roster row that joined the org directly (no onboarding repo, no recoverable
// identity). github_id is the immutable bind key; login/name/avatar are display.
export type MatchCandidate = {
  github_id: string
  login: string
  name: string
  avatar_url: string
}

// Live org/team members NOT already claimed by any roster row in this classroom
// — the smallest, most accurate set for the manual-match picker. A member is
// "claimed" when their numeric id or login appears on a roster row (by github_id
// or username), so a teacher only sees accounts that aren't yet bound to a
// student here. Pure for unit-testing without react-query.
//
// Accepts the minimal member shape it reads (id/login/name/avatar_url) so
// callers don't have to fabricate a full GitHubUser just to feed it.
export type MatchMember = Pick<
  GitHubUser,
  "id" | "login" | "name" | "avatar_url"
>

export function unmatchedTeamMembers(
  members: MatchMember[],
  students: Student[],
): MatchCandidate[] {
  const { ids: claimedIds, logins: claimedLogins } = rosterClaimSet(students)

  return members
    .filter(
      (member) =>
        !claimedIds.has(String(member.id)) &&
        !claimedLogins.has(member.login.toLowerCase()),
    )
    .map((member) => ({
      github_id: String(member.id),
      login: member.login,
      name: member.name ?? "",
      avatar_url: member.avatar_url,
    }))
    .sort((a, b) => a.login.localeCompare(b.login))
}
