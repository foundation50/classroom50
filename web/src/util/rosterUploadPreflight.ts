import { STAFF_ROLES } from "@/types/classroom"
import { sortRolesByRank, type RosterRole } from "@/util/teamRoster"

// Preflight classification for a CSV roster upload. Pure: given the uploaded
// rows (each resolved to a username + intended role) and the classroom's CURRENT
// GitHub membership, it decides what processing each row implies — WITHOUT any
// GitHub calls — so the upload dialog can show, before committing anything:
//
//  - no_action:   already on the team matching the CSV role (a true no-op).
//  - needs_invite: not yet an org member -> a fresh org invite (their acceptance
//                 activates the CSV role's team).
//  - enroll:      an active org member on NONE of this classroom's teams -> an
//                 additive team-add onto the CSV role's team (no team to leave,
//                 so no destructive move and no confirmation needed).
//  - role_change: an active org member whose current classroom role differs from
//                 the CSV role (student<->ta<->instructor). Requires explicit
//                 teacher confirmation because applying it MOVES them between
//                 teams (and an instructor promotion grants org-owner access).
//
// GitHub teams remain the source of truth: this never fabricates a role, only
// compares the CSV's intended role to the live team membership.

export type PreflightRole = RosterRole

// A member's live classroom standing, resolved from the org-member list + the
// three per-classroom team memberships.
export type CurrentMembership = {
  // Active org member (present in the org-members list). A non-member can only
  // be invited, never team-moved.
  isOrgMember: boolean
  // Classroom roles the account currently holds across the student + staff
  // teams (empty when on none). Unioned, so a student+ta holds both.
  roles: RosterRole[]
}

// The uploaded row reduced to what the classifier needs: an identity + intended
// role. `username` is the normalized login; `github_id` (when the enroll pass
// resolved it) anchors membership lookup across a rename.
export type PreflightRow = {
  username: string
  github_id?: string
  role: PreflightRole
}

export type PreflightOutcome =
  | { kind: "no_action"; username: string; role: PreflightRole }
  | { kind: "needs_invite"; username: string; role: PreflightRole }
  | { kind: "enroll"; username: string; role: PreflightRole }
  | {
      kind: "role_change"
      username: string
      // The CSV's intended role (the target team to move onto).
      role: PreflightRole
      // The account's current highest-precedence classroom role (for display).
      currentRole: RosterRole
      // ALL classroom roles the account currently holds. applyRosterRoleChange
      // drops every non-target team, so a member on both the instructor and TA
      // teams moved to student leaves neither staff team behind.
      currentRoles: RosterRole[]
    }

export type PreflightResult = {
  outcomes: PreflightOutcome[]
  noAction: Extract<PreflightOutcome, { kind: "no_action" }>[]
  needsInvite: Extract<PreflightOutcome, { kind: "needs_invite" }>[]
  enroll: Extract<PreflightOutcome, { kind: "enroll" }>[]
  roleChanges: Extract<PreflightOutcome, { kind: "role_change" }>[]
  // True when EVERY uploaded username is already an active org member, so no
  // invitations will be sent (the caller can skip the invite pass entirely).
  allAlreadyMembers: boolean
}

// The highest-precedence role in a set (instructor > ta > student), or undefined
// for an account on no classroom team. Uses the canonical sortRolesByRank so the
// precedence order has a single source (teamRoster.ROLE_RANK).
function primaryOf(roles: RosterRole[]): RosterRole | undefined {
  return roles.length === 0 ? undefined : sortRolesByRank(roles)[0]
}

// Classify each uploaded row against current membership. `lookup` resolves a
// row to its live standing (by github_id, then lowercased login); a row with no
// match is treated as a non-member (invite).
export function classifyRosterUpload(
  rows: PreflightRow[],
  lookup: (row: PreflightRow) => CurrentMembership | undefined,
): PreflightResult {
  const outcomes: PreflightOutcome[] = []

  for (const row of rows) {
    const username = row.username.trim()
    if (!username) continue
    const current = lookup(row)

    // Not an org member (or unknown) -> invite. Acceptance activates the CSV
    // role's team, so this is the only path that creates a membership.
    if (!current || !current.isOrgMember) {
      outcomes.push({ kind: "needs_invite", username, role: row.role })
      continue
    }

    // Already on the team matching the CSV role -> a true no-op. (A person who
    // holds several roles and whose set INCLUDES the CSV role needs no change:
    // they're already on that team.)
    if (current.roles.includes(row.role)) {
      outcomes.push({ kind: "no_action", username, role: row.role })
      continue
    }

    const currentRole = primaryOf(current.roles)
    // Active member on NONE of this classroom's teams: enrolling them onto the
    // CSV role's team is additive (no team to leave), so it's a safe action that
    // needs no destructive-move confirmation.
    if (!currentRole) {
      outcomes.push({ kind: "enroll", username, role: row.role })
      continue
    }

    // Active member whose current role differs from the CSV role -> a move that
    // requires confirmation (student<->ta<->instructor, up or down). Carry the
    // full current role set so the move drops every non-target team, not just
    // the primary one.
    outcomes.push({
      kind: "role_change",
      username,
      role: row.role,
      currentRole,
      currentRoles: [...current.roles],
    })
  }

  const noAction = outcomes.filter(
    (o): o is Extract<PreflightOutcome, { kind: "no_action" }> =>
      o.kind === "no_action",
  )
  const needsInvite = outcomes.filter(
    (o): o is Extract<PreflightOutcome, { kind: "needs_invite" }> =>
      o.kind === "needs_invite",
  )
  const enroll = outcomes.filter(
    (o): o is Extract<PreflightOutcome, { kind: "enroll" }> =>
      o.kind === "enroll",
  )
  const roleChanges = outcomes.filter(
    (o): o is Extract<PreflightOutcome, { kind: "role_change" }> =>
      o.kind === "role_change",
  )

  return {
    outcomes,
    noAction,
    needsInvite,
    enroll,
    roleChanges,
    allAlreadyMembers: needsInvite.length === 0,
  }
}

// Build a membership lookup from the resolved org-member identity sets and the
// per-role team-member id/login sets. Keyed by github_id first, then lowercased
// login, mirroring the identity join used across the roster.
export type ResolvedMembership = {
  orgMemberIds: ReadonlySet<string>
  orgMemberLogins: ReadonlySet<string>
  // Per classroom role -> the id + login sets of that team's live members.
  teamIdsByRole: Record<RosterRole, ReadonlySet<string>>
  teamLoginsByRole: Record<RosterRole, ReadonlySet<string>>
}

export function membershipLookup(
  resolved: ResolvedMembership,
): (row: PreflightRow) => CurrentMembership {
  const roleList: RosterRole[] = ["student", ...STAFF_ROLES]
  return (row: PreflightRow) => {
    const id = row.github_id?.trim() ?? ""
    const login = row.username.trim().toLowerCase()
    const isOrgMember =
      (Boolean(id) && resolved.orgMemberIds.has(id)) ||
      (Boolean(login) && resolved.orgMemberLogins.has(login))
    const roles = roleList.filter(
      (role) =>
        (id && resolved.teamIdsByRole[role]?.has(id)) ||
        (login && resolved.teamLoginsByRole[role]?.has(login)),
    )
    return { isOrgMember, roles }
  }
}

// Turn a GitHub member list into the id + login identity sets the lookup uses.
// (Re-exported from util/identity so the roster and this preflight share one
// fold.)
export { memberIdentitySets } from "@/util/identity"

// Whether any confirmed role change promotes someone to instructor (org owner),
// so the UI can surface the owner-access warning only when relevant.
export function hasInstructorPromotion(
  roleChanges: Extract<PreflightOutcome, { kind: "role_change" }>[],
): boolean {
  return roleChanges.some((c) => c.role === "instructor")
}
