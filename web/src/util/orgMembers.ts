import type { Student } from "@/types/classroom"
import type { GitHubUser } from "@/github-core/types"
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
//  - invitation-pending: on a roster with NO GitHub identity at all, which is
//    what an unaccepted email invite's row looks like. Not a discrepancy: the
//    invitation is live and the account simply doesn't exist here yet, so it must
//    not land in the count that asks the teacher to act.
//  - member-no-roster: an org member on no roster (e.g., co-teacher, or a
//    leftover after an unenroll).
export type MemberClassification =
  | "member-on-roster"
  | "on-roster-not-member"
  | "invitation-pending"
  | "member-no-roster"

export type OrgMemberRow = {
  // Stable identity, mirroring studentKey (github_id || username || email).
  key: string
  username: string
  github_id: string
  name: string
  // The primary email (first seen across rosters) — the one identity keys
  // fall back to. `emails` carries EVERY distinct address the rosters (or the
  // GitHub profile, for a roster-less member) know for this person.
  email: string
  emails: string[]
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
    emails: string[]
    classrooms: RawAccess[]
  }
  const byKey = new Map<string, Acc>()

  // Collect every distinct address (case-insensitive, first-seen casing and
  // order kept) — different rosters may hold different emails for one person.
  const addEmail = (acc: Acc, email: string | undefined) => {
    const trimmed = email?.trim()
    if (!trimmed) return
    if (!acc.emails.some((e) => e.toLowerCase() === trimmed.toLowerCase())) {
      acc.emails.push(trimmed)
    }
  }

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
        addEmail(existing, student.email)
        const name = fullName(student)
        if (!existing.name && name) existing.name = name
      } else {
        const acc: Acc = {
          key,
          username: student.username ?? "",
          github_id: student.github_id ?? "",
          name: fullName(student),
          email: student.email ?? "",
          emails: [],
          classrooms: [access],
        }
        addEmail(acc, student.email)
        byKey.set(key, acc)
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
      emails: acc.emails,
      isMember,
      classrooms,
      // An identity-less roster row is an unaccepted email invite, not a person
      // who left the org — there is no account to have left. Classify it as
      // pending so it stays visible without being counted as a discrepancy.
      classification: isMember
        ? "member-on-roster"
        : acc.username || acc.github_id
          ? "on-roster-not-member"
          : "invitation-pending",
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
      // No roster rows to collect from; the GitHub profile's public email is
      // all we know.
      emails: member.email ? [member.email] : [],
      isMember: true,
      classrooms: [],
      classification: "member-no-roster",
      unprovisionedClassrooms: [],
    })
  }

  // Discrepancies first (the actionable rows), then members, then by login/name.
  // A pending invitation sorts after healthy members: it is informational, and
  // putting it above them would bury the rows a teacher can act on.
  rows.sort((a, b) => {
    const byClass =
      CLASSIFICATION_ORDER[a.classification] -
      CLASSIFICATION_ORDER[b.classification]
    if (byClass !== 0) return byClass
    return displayName(a).localeCompare(displayName(b))
  })

  return rows
}

const CLASSIFICATION_ORDER: Record<MemberClassification, number> = {
  "on-roster-not-member": 0,
  "member-on-roster": 1,
  "invitation-pending": 2,
  "member-no-roster": 3,
}

const displayName = (row: OrgMemberRow) => row.username || row.name || row.email

// What the Name cell shows: the person's name when known, else the identity
// fallbacks the avatar renders.
const nameFirst = (row: OrgMemberRow) => row.name || row.username || row.email

// Header-driven column sort for the Members table (mirroring
// sortTeamRosterRowsBy):
//   name       — display identity (name, else username, else email).
//   username   — GitHub login, blank-last in either direction.
//   classrooms — classroom count.
//   role       — org role precedence (owner -> member -> not a member).
//   status     — the default classification precedence (actionable first).
// `desc` flips only the column comparison; ties always fall back to ascending
// display identity so a reversed column stays internally scannable. `isOwner`
// backs the role column — the owner set lives outside the row (the admins
// read), so the caller supplies the predicate.
export type OrgMembersSortColumn =
  "name" | "username" | "classrooms" | "role" | "status"
export function sortOrgMemberRowsBy(
  rows: OrgMemberRow[],
  column: OrgMembersSortColumn,
  direction: "asc" | "desc",
  isOwner: (row: OrgMemberRow) => boolean = () => false,
): OrgMemberRow[] {
  const flip = direction === "desc" ? -1 : 1
  const byName = (a: OrgMemberRow, b: OrgMemberRow) =>
    displayName(a).localeCompare(displayName(b), undefined, {
      sensitivity: "base",
      numeric: true,
    })
  // Blank-last compare regardless of direction: the inner flip cancels the
  // outer one, so "no data" never leads a reversed column.
  const blankLast = (va: string, vb: string): number => {
    if (!va || !vb) return flip * (va === vb ? 0 : va ? -1 : 1)
    return va.localeCompare(vb, undefined, { numeric: true })
  }
  const roleRank = (row: OrgMemberRow) =>
    isOwner(row) ? 2 : row.isMember ? 1 : 0
  const byColumn = (a: OrgMemberRow, b: OrgMemberRow): number => {
    switch (column) {
      case "name":
        return nameFirst(a).localeCompare(nameFirst(b), undefined, {
          sensitivity: "base",
          numeric: true,
        })
      case "username":
        return blankLast(
          a.username.trim().toLowerCase(),
          b.username.trim().toLowerCase(),
        )
      case "classrooms":
        return a.classrooms.length - b.classrooms.length
      case "role":
        return roleRank(b) - roleRank(a)
      case "status":
        return (
          CLASSIFICATION_ORDER[a.classification] -
          CLASSIFICATION_ORDER[b.classification]
        )
    }
  }
  return rows.toSorted((a, b) => flip * byColumn(a, b) || byName(a, b))
}

// The Members toolbar's "Show" facets, mirroring the roster's combined
// status/role select. Status keys off the row's classification/health; role
// keys off org role (owner vs plain member — a non-member matches neither).
export type OrgMembersStatusFilter =
  "all" | "not-in-org" | "invitation-pending" | "not-enrolled"
export type OrgMembersRoleFilter = "all" | "owner" | "member"

export function filterOrgMemberRows(
  rows: OrgMemberRow[],
  facets: {
    statusFilter: OrgMembersStatusFilter
    roleFilter: OrgMembersRoleFilter
    isOwner: (row: OrgMemberRow) => boolean
  },
): OrgMemberRow[] {
  const { statusFilter, roleFilter, isOwner } = facets
  return rows.filter((row) => {
    if (statusFilter === "not-in-org") {
      if (row.classification !== "on-roster-not-member") return false
    } else if (statusFilter === "invitation-pending") {
      if (row.classification !== "invitation-pending") return false
    } else if (statusFilter === "not-enrolled") {
      if (row.unprovisionedClassrooms.length === 0) return false
    }
    if (roleFilter === "owner") return isOwner(row)
    if (roleFilter === "member") return row.isMember && !isOwner(row)
    return true
  })
}
