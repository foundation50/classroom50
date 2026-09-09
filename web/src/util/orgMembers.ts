import type { Student } from "@/types/classroom"
import type { GitHubOrgInvitation, GitHubUser } from "@/github-core/types"
import { memberIdSet, studentKey } from "@/util/identity"
import {
  failedInvitationRef,
  hasExpiredInvite,
  indexFailedInvitations,
  type FailedInvitationRef,
} from "./teamRoster"
import { resolveGitHubId } from "./students"
import { sortByColumn } from "./sortColumns"

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

// How an aggregated row relates org membership to roster presence. Mirrors the
// roster's states (util/teamRoster) so the two pages agree about a person:
//  - member-on-roster: a healthy member on >=1 roster (roster: enrolled).
//  - on-roster-not-member: on a roster with a GitHub account that is not an org
//    member and has no live invitation (roster: needs_attention_not_in_org).
//    The discrepancy the teacher acts on.
//  - invitation-pending: on a roster with a LIVE org invitation, by account or
//    by email (roster: pending). Verified against GitHub's pending list, never
//    inferred from the row's shape. Informational, not a discrepancy.
//  - unlinked: on a roster with no GitHub account and no live invitation
//    (roster: unlinked). The invitation expired, was canceled, or never went
//    out; `failed_invitation` says which when GitHub still has the record.
//  - member-no-roster: an org member on no roster (e.g., co-teacher, or a
//    leftover after an unenroll).
export type MemberClassification =
  | "member-on-roster"
  | "on-roster-not-member"
  | "invitation-pending"
  | "unlinked"
  | "member-no-roster"

export type OrgMemberRow = {
  // Stable identity, mirroring studentKey (github_id || username || email).
  key: string
  username: string
  github_id: string
  name: string
  // The primary email (first seen across rosters) — identity keys fall back
  // to it. `emails` is every distinct address the rosters (or, for a
  // roster-less member, the GitHub profile) know.
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
  // The live org invitation behind an `invitation-pending` row.
  invitation_id?: number
  // GitHub's failed record for the last invitation to a stranded row (unlinked
  // or on-roster-not-member), the same shape the roster attaches. Explains why
  // the row is stranded and names the record a re-invite must dismiss.
  failed_invitation?: FailedInvitationRef
}

// The org's invitation lists (owner-only reads). Pass `pending` only once it
// has loaded: without it every identity-less row reads as unlinked, since a
// live invitation is unknowable, and a pending student would be mislabeled.
export type OrgInvitationLists = {
  pending?: GitHubOrgInvitation[]
  failed?: GitHubOrgInvitation[]
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
  invitations: OrgInvitationLists = {},
): OrgMemberRow[] {
  const memberIds = memberIdSet(members)

  // Live invitations by lowercased login and email. A login invite (sent by
  // id) carries the account's login; an email invite carries only the address.
  const pendingByLogin = new Map<string, number>()
  const pendingByEmail = new Map<string, number>()
  for (const inv of invitations.pending ?? []) {
    const login = inv.login?.trim().toLowerCase()
    const email = inv.email?.trim().toLowerCase()
    if (login && !pendingByLogin.has(login)) pendingByLogin.set(login, inv.id)
    if (email && !pendingByEmail.has(email)) pendingByEmail.set(email, inv.id)
  }
  const { byLogin: failedByLogin, byEmail: failedByEmail } =
    indexFailedInvitations(invitations.failed ?? [])
  // A row's live invitation, else its latest failed record. Login first (the
  // account is the stronger identity), then any of the row's addresses.
  const invitationFor = (acc: {
    username: string
    emails: string[]
  }): { invitation_id?: number; failed_invitation?: FailedInvitationRef } => {
    const login = acc.username.trim().toLowerCase()
    const emails = acc.emails.map((e) => e.trim().toLowerCase())
    const pendingId =
      (login ? pendingByLogin.get(login) : undefined) ??
      emails.map((e) => pendingByEmail.get(e)).find((id) => id !== undefined)
    if (pendingId !== undefined) return { invitation_id: pendingId }
    const failed =
      (login ? failedByLogin.get(login) : undefined) ??
      emails.map((e) => failedByEmail.get(e)).find((ref) => ref !== undefined)
    return failed ? { failed_invitation: failed } : {}
  }
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

  // Every distinct address (case-insensitive; first-seen casing and order) —
  // rosters may hold different emails for one person.
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

    // A non-member's standing is decided by GitHub's invitation lists, never by
    // the row's shape: a live invitation makes it pending whether it went to an
    // account or an address; otherwise an account-bearing row is not in the
    // org and an identity-less one is unlinked, each carrying the failed record
    // that explains it when GitHub still has one. A member's stale record is
    // noise (they got in some other way) and is dropped.
    const invite = isMember ? {} : invitationFor(acc)
    const classification: MemberClassification = isMember
      ? "member-on-roster"
      : invite.invitation_id !== undefined
        ? "invitation-pending"
        : acc.username || acc.github_id
          ? "on-roster-not-member"
          : "unlinked"

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
      classification,
      unprovisionedClassrooms,
      ...invite,
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

  // Actionable rows first (not in org, then unlinked), then members, then the
  // informational pending invitations, then members on no roster; ties by
  // login/name. Pending sorts after healthy members so it never buries the
  // rows a teacher must act on.
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
  unlinked: 1,
  "member-on-roster": 2,
  "invitation-pending": 3,
  "member-no-roster": 4,
}

const displayName = (row: OrgMemberRow) => row.username || row.name || row.email

// What the Name cell shows: the name when known, else the avatar's fallbacks.
const nameFirst = (row: OrgMemberRow) => row.name || row.username || row.email

// Column sort for the Members table. `isOwner` backs the role column: ownership
// lives outside the row (the admins read), so the caller supplies it.
export type OrgMembersSortColumn =
  "name" | "username" | "classrooms" | "role" | "status"
export function sortOrgMemberRowsBy(
  rows: OrgMemberRow[],
  column: OrgMembersSortColumn,
  direction: "asc" | "desc",
  isOwner: (row: OrgMemberRow) => boolean = () => false,
): OrgMemberRow[] {
  const byName = (a: OrgMemberRow, b: OrgMemberRow) =>
    displayName(a).localeCompare(displayName(b), undefined, {
      sensitivity: "base",
      numeric: true,
    })
  const roleRank = (row: OrgMemberRow) =>
    isOwner(row) ? 2 : row.isMember ? 1 : 0
  return sortByColumn(
    rows,
    direction,
    (a, b, blankLast) => {
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
    },
    byName,
  )
}

// The Members toolbar's "Show" facets (the roster's combined select). Status
// keys off classification/health; role off org role — a non-member matches
// neither role. "invite-expired" is cross-classification, like the roster's:
// an expired row keeps its classification (unlinked or not in org).
export type OrgMembersStatusFilter =
  | "all"
  | "not-in-org"
  | "invitation-pending"
  | "unlinked"
  | "invite-expired"
  | "not-enrolled"
export type OrgMembersRoleFilter = "all" | "owner" | "member"

export { hasExpiredInvite }

// The rows the org-invite action can send to: on a roster, not a member, no
// live invitation, and a usable github_id (the invite is sent by id). One rule
// for the bulk bar's eligibility count and the domain's skip guard.
export const isInvitableToOrg = (row: OrgMemberRow): boolean =>
  row.classification === "on-roster-not-member" &&
  resolveGitHubId(row.github_id) !== null

// How a Members row is named in progress captions and result lists.
export const orgMemberLabel = (row: OrgMemberRow): string =>
  row.username || row.email || row.key

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
    } else if (statusFilter === "unlinked") {
      if (row.classification !== "unlinked") return false
    } else if (statusFilter === "invite-expired") {
      if (!hasExpiredInvite(row)) return false
    } else if (statusFilter === "not-enrolled") {
      if (row.unprovisionedClassrooms.length === 0) return false
    }
    if (roleFilter === "owner") return isOwner(row)
    if (roleFilter === "member") return row.isMember && !isOwner(row)
    return true
  })
}

// A failed/expired invitation GitHub still lists that no classroom can explain:
// its email and login match no roster row in any classroom AND no active member.
// Such a record has nothing on any roster to badge or re-invite from (the row
// was removed, or the invitation was never Classroom 50's), so it can only be
// dismissed, and only by an explicit owner action: an owner-sent invitation
// unrelated to any classroom looks identical, so nothing sweeps these
// automatically.
export type OrphanedFailedInvitation = {
  invitation: GitHubOrgInvitation
  ref: FailedInvitationRef
}

export function orphanedFailedInvitations(
  failed: GitHubOrgInvitation[],
  members: GitHubUser[],
  rosters: ClassroomRoster[],
): OrphanedFailedInvitation[] {
  const logins = new Set<string>()
  const emails = new Set<string>()
  for (const m of members) {
    logins.add(m.login.toLowerCase())
    const email = m.email?.trim().toLowerCase()
    if (email) emails.add(email)
  }
  for (const roster of rosters) {
    for (const s of roster.students) {
      const login = s.username?.trim().toLowerCase()
      const email = s.email?.trim().toLowerCase()
      if (login) logins.add(login)
      if (email) emails.add(email)
    }
  }
  return failed
    .filter((inv) => {
      const login = inv.login?.trim().toLowerCase()
      const email = inv.email?.trim().toLowerCase()
      if (login && logins.has(login)) return false
      if (email && emails.has(email)) return false
      return true
    })
    .map((invitation) => ({
      invitation,
      ref: failedInvitationRef(invitation),
    }))
    .sort(
      (a, b) =>
        (b.ref.failed_at ?? "").localeCompare(a.ref.failed_at ?? "") ||
        a.invitation.id - b.invitation.id,
    )
}
