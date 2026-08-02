import type { GitHubClient } from "@/github-core/client"
import {
  addUserToTeam,
  ensureClassroomRoleTeam,
  grantTeamConfigRepoAccess,
  readOrgMembershipState,
  removeUserFromTeam,
  setOrgMembershipRole,
} from "@/github-core/mutations"
import { getErrorMessage } from "@/github-core/errorMessage"
import { assertClassroomNotArchived } from "../classrooms"
import {
  getRawFile,
  getUser,
  listAllOrgMembers,
  listOrgAdmins,
  listTeamMembers,
} from "@/github-core/queries"
import { getAuthenticatedUser } from "@/domain/queries/users"
import {
  getBranchRef,
  getConfigRepoBranch,
} from "@/github-core/configRepoReads"
import { isSameGitHubUser } from "@/util/students"
import { parseRosterCsv } from "@/util/rosterCsv"
import { rosterPath } from "@/util/rosterPath"
import { type ClassroomRole } from "@/util/teamRoster"
import { isTeacherRole } from "@/authz"
import { memberIdentitySets } from "@/util/identity"
import {
  classifyRosterUpload,
  membershipLookup,
  type CurrentMembership,
  type PreflightResult,
  type PreflightRow,
  type ResolvedMembership,
  type StoredRosterRow,
} from "@/util/rosterUploadPreflight"
import {
  mergeStudentMetadata,
  applyMetadataMerge,
  type StudentMetadata,
} from "@/util/rosterMetadataMerge"
import {
  log,
  normalizeGithubUsername,
  withRosterRewrite,
  resolveClassroomTeamSlug,
  resolveClassroomTeamSlugs,
} from "./rosterPrimitives"
import type { StaffRole } from "@/types/classroom"

export type WriteClassroomRolesInput = {
  org: string
  classroom: string
  // Usernames -> the role to persist on their roster.csv row. Used by the upload
  // to write an assigned role for a freshly-invited (still-pending) member,
  // whose role auto-sync can't yet derive from team membership.
  roles: { username: string; role: ClassroomRole }[]
}

// Set the `role` column on existing roster.csv rows matched by username. Only
// touches rows that exist and whose role actually changes; never appends,
// removes, or edits other fields. Best-effort caller (upload) — a conflict-safe
// single commit.
export async function writeClassroomRoles(
  client: GitHubClient,
  input: WriteClassroomRolesInput,
): Promise<{ changed: number }> {
  const { org, classroom } = input
  await assertClassroomNotArchived(client, org, classroom)
  const roleByLogin = new Map(
    input.roles
      .map((r) => [r.username.trim().toLowerCase(), r.role] as const)
      .filter(([login]) => login),
  )
  if (roleByLogin.size === 0) return { changed: 0 }

  return withRosterRewrite(client, { org, classroom }, (currentStudents) => {
    let changed = 0
    const nextStudents = currentStudents.map((s) => {
      const role = roleByLogin.get(s.username.trim().toLowerCase())
      if (role && role !== s.role) {
        changed++
        return { ...s, role }
      }
      return s
    })
    return {
      nextStudents,
      changed,
      message: `Set role on ${changed} roster member${changed === 1 ? "" : "s"}: ${classroom}`,
    }
  })
}

export type UpdateClassroomMetadataInput = {
  org: string
  classroom: string
  // Existing members whose roster.csv metadata the CSV upload changes. Matched
  // to a stored row by github_id (when known) then lowercased login. Only the
  // four metadata fields are updatable; identity and role are never touched.
  updates: (StudentMetadata & { username: string; github_id?: string })[]
}

// Merge changed non-empty metadata (first/last/email/section) into existing
// roster.csv rows in a single conflict-safe commit. Mirrors writeClassroomRoles:
// only touches rows that exist and actually change, never appends/removes/
// reorders, applies the formula-injection guard via stringifyStudentsCsv, and
// raises a typed RosterCsvMalformedError on an unparseable file rather than
// corrupting it. A blank CSV cell never clears a stored value (mergeStudentMetadata).
export async function updateClassroomMetadata(
  client: GitHubClient,
  input: UpdateClassroomMetadataInput,
): Promise<{ changed: number }> {
  const { org, classroom } = input
  await assertClassroomNotArchived(client, org, classroom)

  const updateById = new Map<string, StudentMetadata>()
  const updateByLogin = new Map<string, StudentMetadata>()
  for (const u of input.updates) {
    const metadata: StudentMetadata = {
      first_name: u.first_name,
      last_name: u.last_name,
      email: u.email,
      section: u.section,
    }
    const id = u.github_id?.trim()
    const login = u.username.trim().toLowerCase()
    if (id) updateById.set(id, metadata)
    if (login) updateByLogin.set(login, metadata)
  }
  if (updateById.size === 0 && updateByLogin.size === 0) return { changed: 0 }

  return withRosterRewrite(client, { org, classroom }, (currentStudents) => {
    let changed = 0
    const nextStudents = currentStudents.map((s) => {
      const update =
        (s.github_id ? updateById.get(s.github_id.trim()) : undefined) ??
        updateByLogin.get(s.username.trim().toLowerCase())
      if (!update) return s
      const { next, changedFields } = mergeStudentMetadata(s, update)
      if (changedFields.length === 0) return s
      changed++
      return applyMetadataMerge(s, next)
    })
    return {
      nextStudents,
      changed,
      message: `Update metadata on ${changed} roster member${changed === 1 ? "" : "s"}: ${classroom}`,
    }
  })
}

export type ResolveRosterUploadPreflightInput = {
  org: string
  classroom: string
  // The uploaded rows reduced to identity + intended role. github_id is
  // optional (threaded when the enroll pass has resolved it) and anchors the
  // membership lookup across a login rename.
  rows: PreflightRow[]
}

// The role-independent inputs to the preflight classification: the live
// membership lookup and the stored-roster metadata lookup. Reading these hits
// GitHub (org + team lists + roster.csv), but the result does NOT depend on the
// rows' assigned roles — so the caller can resolve this ONCE per uploaded file
// and re-run the pure classifyRosterUpload synchronously on every role edit,
// rather than re-fetching (and flashing a loading state) on each keystroke.
export type RosterUploadContext = {
  lookup: (row: PreflightRow) => CurrentMembership
  storedByIdentity: (row: PreflightRow) => StoredRosterRow | undefined
}

// Read the classroom's CURRENT GitHub membership + stored roster.csv metadata
// into the role-independent classification context. Read-only. The team reads
// 404-tolerate (an uncreated staff team reads as empty) and the org-member read
// pages to completion; a hard failure of either propagates so the caller
// surfaces "couldn't preview, try again" rather than a wrong plan.
export async function resolveRosterUploadContext(
  client: GitHubClient,
  input: { org: string; classroom: string },
): Promise<RosterUploadContext> {
  const { org, classroom } = input
  const slugs = await resolveClassroomTeamSlugs(client, org, classroom)

  // The stored-roster read is independent of the team/org-membership reads, so
  // run it in the same wave rather than as a serial second stage.
  const [
    [orgMembers, studentMembers, teacherMembers, htaMembers, taMembers],
    storedByIdentity,
  ] = await Promise.all([
    Promise.all([
      listAllOrgMembers(client, org),
      listTeamMembers(client, org, slugs.student),
      listTeamMembers(client, org, slugs.staff.teacher),
      listTeamMembers(client, org, slugs.staff.hta),
      listTeamMembers(client, org, slugs.staff.ta),
    ]),
    resolveStoredRosterLookup(client, org, classroom),
  ])

  const orgSets = memberIdentitySets(orgMembers)
  const studentSets = memberIdentitySets(studentMembers)
  const teacherSets = memberIdentitySets(teacherMembers)
  const htaSets = memberIdentitySets(htaMembers)
  const taSets = memberIdentitySets(taMembers)

  const resolved: ResolvedMembership = {
    orgMemberIds: orgSets.ids,
    orgMemberLogins: orgSets.logins,
    teamIdsByRole: {
      student: studentSets.ids,
      teacher: teacherSets.ids,
      hta: htaSets.ids,
      ta: taSets.ids,
    },
    teamLoginsByRole: {
      student: studentSets.logins,
      teacher: teacherSets.logins,
      hta: htaSets.logins,
      ta: taSets.logins,
    },
  }

  return { lookup: membershipLookup(resolved), storedByIdentity }
}

// Convenience wrapper: read the context (see resolveRosterUploadContext) and
// run the pure classification in one call, returning the full PreflightResult.
// Callers that reclassify repeatedly (per role edit) should instead read the
// context once and call classifyRosterUpload themselves.
export async function resolveRosterUploadPreflight(
  client: GitHubClient,
  input: ResolveRosterUploadPreflightInput,
): Promise<PreflightResult> {
  const { org, classroom, rows } = input
  const { lookup, storedByIdentity } = await resolveRosterUploadContext(
    client,
    { org, classroom },
  )
  return classifyRosterUpload(rows, lookup, storedByIdentity)
}

// Read the current roster.csv and build a stored-metadata lookup keyed by
// github_id first, then lowercased login (mirroring the membership join). Used
// by the upload preflight to detect a metadata_update against an already-
// enrolled member. Tolerant by design: a malformed/absent roster degrades to an
// empty lookup (classify as today, no metadata_update) rather than failing the
// read-only preview — the write path (updateClassroomMetadata) re-reads and
// surfaces RosterCsvMalformedError when the teacher actually commits.
async function resolveStoredRosterLookup(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<(row: PreflightRow) => StoredRosterRow | undefined> {
  const byId = new Map<string, StoredRosterRow>()
  const byLogin = new Map<string, StoredRosterRow>()
  try {
    const configBranch = await getConfigRepoBranch(client, org)
    const ref = await getBranchRef(client, org, configBranch)
    const currentCsv = await getRawFile(client, {
      org,
      path: rosterPath(classroom),
      ref: ref.object.sha,
    })
    const { rows: students } = parseRosterCsv(currentCsv)
    for (const s of students) {
      const metadata: StoredRosterRow = {
        first_name: s.first_name,
        last_name: s.last_name,
        email: s.email,
        section: s.section,
      }
      if (s.github_id) byId.set(s.github_id.trim(), metadata)
      if (s.username) byLogin.set(s.username.trim().toLowerCase(), metadata)
    }
  } catch (err) {
    log.warn("roster upload preflight: stored-roster read failed", { err })
    return () => undefined
  }
  return (row: PreflightRow) => {
    const id = row.github_id?.trim()
    return (
      (id ? byId.get(id) : undefined) ??
      byLogin.get(row.username.trim().toLowerCase())
    )
  }
}

export type ApplyClassroomRoleChangeInput = {
  org: string
  classroom: string
  username: string
  github_id?: string
  // ALL classroom roles the account currently holds (the teams to move OFF of).
  // Empty for an additive enroll (an active member on no team) — then no team
  // is dropped. The target team is never dropped even if present here.
  fromRoles: ClassroomRole[]
  // The CSV's intended role (the team to move ONTO).
  toRole: ClassroomRole
}

export type ApplyClassroomRoleChangeResult = {
  username: string
  toRole: ClassroomRole
  // Non-fatal warnings (a best-effort old-team removal that failed, etc.).
  warnings: string[]
}

// Apply a CONFIRMED role change (or an additive enroll) for an active org
// member: move them onto the CSV role's team and off every other classroom
// team. The caller must only invoke this for a member the preflight classified
// as `role_change` or `enroll` and — for a teacher target or a demotion off
// teacher — the teacher confirmed, since it grants/revokes org-OWNER.
//
// Ordering is chosen so a mid-sequence failure never leaves ELEVATED access
// dangling:
//  0) Before any change, refuse an org-OWNER revocation that would be
//     self-inflicted or strip the last owner (self-demotion / sole-owner
//     demotion) — both are unrecoverable-in-place, so they're blocked outright.
//  1) Demote org owner -> member FIRST when leaving teacher for a
//     non-teacher role. Done before any team change, so if it throws we abort
//     with the member unchanged (still teacher + owner) rather than
//     half-moved-but-still-owner. If a LATER step fails after this committed,
//     the error explicitly says the owner was revoked so the caller re-runs.
//  2) Add to the target team (student -> classroom team; ta/teacher -> the
//     staff team, created + granted its role's config-repo access — write for
//     teacher/hta, read-only for ta — if missing), then promote
//     to org owner when the target is teacher.
//  3) Remove from EVERY currently-held classroom team that isn't the target
//     (best-effort — a failed drop is a warning, since the target add + any
//     owner change already landed). Dropping all non-target teams (not just the
//     primary) means a member on both the teacher and TA teams moved to
//     student leaves neither staff team behind.
//
// NEVER team-adds a non-member (that would create a stray team invitation); the
// preflight only produces role_change/enroll for active members, and this
// re-verifies.
export async function applyClassroomRoleChange(
  client: GitHubClient,
  input: ApplyClassroomRoleChangeInput,
): Promise<ApplyClassroomRoleChangeResult> {
  const { org, classroom, fromRoles, toRole } = input
  const username = input.username.trim()
  await assertClassroomNotArchived(client, org, classroom)
  if (!username) throw new Error("A username is required")

  const warnings: string[] = []

  // Re-verify active membership directly: only a definitive 404 is not-a-member
  // (a transient read rethrows so the caller retries rather than team-adding a
  // non-member on a blip).
  const state = await readOrgMembershipState(client, org, username)
  if (state !== "active") {
    throw new Error(
      `${username} is not an active member of ${org}, so their role can't be ` +
        `changed here; invite them to the organization instead.`,
    )
  }

  const slugs = await resolveClassroomTeamSlugs(client, org, classroom)
  const slugForRole = (role: ClassroomRole): string =>
    role === "student" ? slugs.student : slugs.staff[role]

  // Teacher is the org-owner role.
  const wasTeacher = fromRoles.some(isTeacherRole)
  const toIsTeacher = isTeacherRole(toRole)
  const demotesOwner = wasTeacher && !toIsTeacher

  // Guard the org-OWNER revocation before touching anything. Demoting yourself
  // strips your own admin mid-operation (you may then lose permission to finish
  // the very move you started); demoting the sole owner leaves the org with no
  // owner. Both are refused outright rather than half-applied. listOrgAdmins is
  // owner-only and returns [] on 403 — the acting owner can read it, so a
  // confirmed single-owner set is trustworthy; an unreadable ([]) list does not
  // block (preserves the prior fail-open behavior for a degraded read).
  if (demotesOwner) {
    const viewer = await getAuthenticatedUser(client)
    if (isSameGitHubUser(viewer, { github_id: input.github_id, username })) {
      throw new Error(
        `You can't demote yourself from teacher here — it would revoke ` +
          `your own organization-owner access mid-change. Ask another owner ` +
          `to change your role.`,
      )
    }
    const admins = await listOrgAdmins(client, org)
    const soleOwner =
      admins.length === 1 &&
      isSameGitHubUser(admins[0], { github_id: input.github_id, username })
    if (soleOwner) {
      throw new Error(
        `${username} is the only organization owner, so they can't be demoted ` +
          `from teacher — promote another owner first.`,
      )
    }
  }

  // 1) Demote org owner FIRST when leaving teacher for a non-teacher role.
  // Doing this before any team mutation guarantees a failure here leaves the
  // member fully unchanged (still owner) rather than partially moved but still
  // an owner — the dangerous partial state.
  let ownerRevoked = false
  try {
    if (demotesOwner) {
      await setOrgMembershipRole(client, { org, username, role: "member" })
      ownerRevoked = true
    }

    // 2) Add to the target team (ensure a staff team exists + config write),
    // then promote to org owner for a teacher target.
    if (toRole === "student") {
      await addUserToTeam(client, {
        org,
        teamSlug: slugs.student,
        username,
        role: "member",
      })
    } else {
      const team = await ensureClassroomRoleTeam(client, org, classroom, toRole)
      await grantTeamConfigRepoAccess(client, org, team.slug, toRole)
      await addUserToTeam(client, {
        org,
        teamSlug: team.slug,
        username,
        role: "member",
      })
    }
    if (toIsTeacher) {
      await setOrgMembershipRole(client, { org, username, role: "admin" })
    }
  } catch (err) {
    // A failure AFTER the owner demote committed leaves the member no longer an
    // owner but not yet on the target team — a half-applied elevated-access
    // change the caller must know to re-run, not a silent generic failure.
    if (ownerRevoked) {
      throw new Error(
        `${username} was demoted from organization owner, but moving them to ` +
          `the ${toRole} team then failed (${getErrorMessage(err)}). Re-run ` +
          `the role change to finish the move.`,
        { cause: err },
      )
    }
    throw err
  }

  // 3) Remove from EVERY currently-held classroom team except the target
  // (best-effort). Dedupe so a role held twice isn't dropped twice.
  const toDrop = [...new Set(fromRoles)].filter((role) => role !== toRole)
  for (const role of toDrop) {
    const fromSlug = slugForRole(role)
    if (!fromSlug) continue
    try {
      await removeUserFromTeam(client, { org, teamSlug: fromSlug, username })
    } catch (err) {
      log.error("role-change old-team removal failed", { err, role })
      warnings.push(
        `${username} was added to the ${toRole} team, but removing them from ` +
          `their previous ${role} team failed (${getErrorMessage(err)}); ` +
          `retry to complete the move.`,
      )
    }
  }

  return { username, toRole, warnings }
}

export type AssignRosterMemberRoleInput = {
  org: string
  classroom: string
  username: string
  role: ClassroomRole
}

export type AssignRosterMemberRoleResult =
  // Added to the target team.
  | { state: "assigned"; role: ClassroomRole }
  // Not an active org member (must be invited first, not team-added).
  | { state: "not-member" }

// Assign a roster member (who is an active org member but on none of this
// classroom's teams — a `needs_attention_in_org` row) a classroom role by
// adding them to the target team: the classroom team for "student", else the
// per-classroom staff team (created + granted config write if missing, mirroring
// the Settings staff flow). NEVER team-adds a non-member — GitHub would create a
// team INVITATION for a non-member, so a non-member is reported as `not-member`
// and routed to the invite affordance instead. Idempotent (PUT membership).
export async function assignRosterMemberRole(
  client: GitHubClient,
  input: AssignRosterMemberRoleInput,
): Promise<AssignRosterMemberRoleResult> {
  const { org, classroom, role } = input
  const username = input.username.trim()
  await assertClassroomNotArchived(client, org, classroom)
  if (!username) throw new Error("A username is required")

  // Never team-add a non-member (GitHub would create a stray team invitation,
  // not an enrollment) — the caller routes a confirmed non-member to the invite
  // action. readOrgMembershipState surfaces a TRANSIENT read failure as an
  // error the caller can retry (rather than misreporting it as "not a member",
  // which would wrongly send the teacher to re-invite an already-active member).
  // Only a definitive 404 (null) — or a non-active state — means not-a-member.
  const state = await readOrgMembershipState(client, org, username)
  if (state !== "active") {
    return { state: "not-member" }
  }

  const teamSlug =
    role === "student"
      ? await resolveClassroomTeamSlug(client, org, classroom)
      : (await ensureClassroomRoleTeam(client, org, classroom, role)).slug
  if (role !== "student") {
    await grantTeamConfigRepoAccess(client, org, teamSlug, role)
  }

  await addUserToTeam(client, { org, teamSlug, username, role: "member" })
  return { state: "assigned", role }
}

export type AddClassroomStaffMemberInput = {
  org: string
  classroom: string
  username: string
  role: StaffRole
}

// Add a staff member (teacher / head TA / TA) to a classroom's role team. The
// deliberate counterpart to assignRosterMemberRole: that refuses a non-member
// (the roster routes them to a separate org-invite affordance), whereas the
// Settings staff flow's whole purpose is "type a username -> put them on the
// staff team", so this team-adds UNCONDITIONALLY — GitHub turns a team-add of a
// non-member into a team invitation, which is exactly the pending-staff state
// the section renders.
//
// Steps: verify the account exists (a clear error vs. a confusing team 422) ->
// ensure-and-grant the role team (self-healing preflight) -> strip the
// auto-added creator on a freshly-created team (GitHub adds the CREATOR as
// maintainer; adding a TA must not also make the acting teacher a TA) -> add the
// target. Idempotent (PUT membership).
export async function addClassroomStaffMember(
  client: GitHubClient,
  input: AddClassroomStaffMemberInput,
): Promise<{ username: string; role: StaffRole }> {
  const { org, classroom, role } = input
  const username = normalizeGithubUsername(input.username)
  await assertClassroomNotArchived(client, org, classroom)
  if (!username) throw new Error("A username is required")

  // Verify the account exists first so a typo surfaces as "no such user"
  // instead of a confusing team-membership 422 later.
  await getUser(client, username)

  const team = await ensureClassroomRoleTeam(client, org, classroom, role)
  await grantTeamConfigRepoAccess(client, org, team.slug, role)

  // GitHub auto-adds the team CREATOR as maintainer. If this call just created
  // the team, drop the acting user unless they're the target — best-effort, the
  // actor can remove themselves via the same UI. Resolve the actor fresh (as
  // applyClassroomRoleChange does) rather than trusting a cached identity.
  if (team.created) {
    try {
      const actor = await getAuthenticatedUser(client)
      if (actor.login && actor.login.toLowerCase() !== username.toLowerCase()) {
        await removeUserFromTeam(client, {
          org,
          teamSlug: team.slug,
          username: actor.login,
        })
      }
    } catch {
      // Non-fatal: leave the creator on the team; they can self-remove.
    }
  }

  await addUserToTeam(client, {
    org,
    teamSlug: team.slug,
    username,
    role: "member",
  })
  return { username, role }
}

export type RemoveClassroomStaffMemberInput = {
  org: string
  teamSlug: string
  username: string
  // The role the team represents, so a self-removal from the TEACHER team can be
  // refused (it revokes the acting owner's own owner-level classroom access).
  role: StaffRole
}

// Remove a staff member from a classroom's role team. Refuses a teacher removing
// THEMSELVES from the teacher team: like the roster's self-demote guard, that
// would revoke the acting owner's own owner-level access to the classroom — an
// unrecoverable-in-place action they must have another owner perform. Other
// removals (a different member, or self off a non-teacher team) pass through to
// the idempotent team-drop.
export async function removeClassroomStaffMember(
  client: GitHubClient,
  input: RemoveClassroomStaffMemberInput,
): Promise<void> {
  const { org, teamSlug, username, role } = input
  if (isTeacherRole(role)) {
    const viewer = await getAuthenticatedUser(client)
    if (isSameGitHubUser(viewer, { username })) {
      throw new Error(
        `You can't remove yourself from the teacher team — it would revoke ` +
          `your own owner-level access to this classroom. Ask another ` +
          `organization owner to remove you.`,
      )
    }
  }
  await removeUserFromTeam(client, { org, teamSlug, username })
}
