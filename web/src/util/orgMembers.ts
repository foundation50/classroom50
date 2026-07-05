import type { Student } from "@/types/classroom"
import type { GitHubUser } from "@/hooks/github/types"
import { memberIdSet, studentKey } from "@/util/identity"

// Per-classroom enrollment state for an aggregated member, mirroring
// buildTeamRoster so the two views agree:
//  - enrolled:      on the classroom's `classroom50-<classroom>` team (the
//                   enrollment source of truth), OR team data was unavailable
//                   (unknown is treated as enrolled, never flagged).
//  - unprovisioned: on the CSV roster but NOT on the team (or a failed
//                   team-add). Grade collection is team-driven, so uncollected.
export type ClassroomAccessState = "enrolled" | "unprovisioned"

// One classroom a student appears on.
export type ClassroomAccess = {
  classroom: string
  archived: boolean
  section: string
  state: ClassroomAccessState
}

// How an aggregated row relates org membership to roster presence:
//  - member-on-roster: a healthy member on >=1 roster.
//  - on-roster-not-member: the target discrepancy — on a roster but no longer
//    (or never) an org member.
//  - member-no-roster: an org member on no roster (e.g. co-teacher, or a
//    leftover after an unenroll).
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
  // Classrooms where the member is on the CSV roster but NOT on the live
  // `classroom50-<classroom>` team (grade collection is team-driven, so
  // uncollected). Empty when team data was unavailable or all consistent. Only
  // meaningful for members (a non-member is already on-roster-not-member).
  unprovisionedClassrooms: string[]
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

// Deduplicate students across rosters (by studentKey), match each to a live org
// member by numeric github_id, fold in members on no roster, and classify every
// row. Pure so the dedupe/match/classify logic is testable without react-query.
// Uses the SAME keys as the per-classroom roster (studentKey / memberIdSet) so
// the two views agree.
export function aggregateOrgMembers(
  members: GitHubUser[],
  rosters: ClassroomRoster[],
  // Optional classroom -> set of live team-member id strings. When provided,
  // each ClassroomAccess is marked onTeam and CSV/team drift surfaced. A
  // classroom absent from the map has "unknown" team data and is never flagged.
  teamMembersByClassroom?: Map<string, Set<string>>,
): OrgMemberRow[] {
  const memberIds = memberIdSet(members)
  // Login -> id, so a roster row with a username but no github_id (typed before
  // reconcile) still matches a live member. Without this it's classified
  // on-roster-not-member AND the member is emitted as member-no-roster — the
  // same person counted twice.
  const memberIdByLogin = new Map<string, string>(
    members.map((m) => [m.login.toLowerCase(), String(m.id)]),
  )

  // Raw per-classroom access before the member id is resolved; onTeam is
  // computed in the classify loop once we know the member's id.
  type RawAccess = { classroom: string; archived: boolean; section: string }
  type Acc = {
    key: string
    username: string
    github_id: string
    name: string
    email: string
    classrooms: RawAccess[]
  }
  const byKey = new Map<string, Acc>()

  for (const roster of rosters) {
    for (const student of roster.students) {
      const key = studentKey(student)
      if (!key) continue
      const access: RawAccess = {
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
    // Match by github_id when present, else fall back to login (a row not yet
    // reconciled to an id). The resolved id is recorded in matchedMemberIds so
    // the no-roster fold below doesn't emit a duplicate.
    const loginId = acc.username
      ? memberIdByLogin.get(acc.username.toLowerCase())
      : undefined
    const matchedId =
      acc.github_id && memberIds.has(acc.github_id)
        ? acc.github_id
        : (loginId ?? "")
    const isMember = Boolean(matchedId)
    if (isMember) matchedMemberIds.add(matchedId)

    // Finalize each access with its team-authoritative state. A classroom with
    // no team data is "unknown" -> enrolled. unprovisioned = a member on the CSV
    // roster but not the team; only real members can be unprovisioned (a
    // non-member is already on-roster-not-member). Archived classrooms are
    // excluded (their team may be intentionally gone).
    const unprovisionedClassrooms: string[] = []
    const classrooms: ClassroomAccess[] = acc.classrooms.map((raw) => {
      const teamSet = teamMembersByClassroom?.get(raw.classroom)
      const onTeam = !teamSet || (Boolean(matchedId) && teamSet.has(matchedId))
      const unprovisioned = isMember && Boolean(teamSet) && !onTeam
      if (unprovisioned && !raw.archived) {
        unprovisionedClassrooms.push(raw.classroom)
      }
      return {
        ...raw,
        state: unprovisioned ? "unprovisioned" : "enrolled",
      }
    })

    rows.push({
      key: acc.key,
      username: acc.username,
      // Prefer the resolved live member id over a roster id: a stale CSV id
      // that matched only by login would otherwise be shown/used.
      github_id: matchedId || acc.github_id,
      name: acc.name,
      email: acc.email,
      isMember,
      classrooms,
      classification: isMember ? "member-on-roster" : "on-roster-not-member",
      unprovisionedClassrooms,
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
      unprovisionedClassrooms: [],
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
