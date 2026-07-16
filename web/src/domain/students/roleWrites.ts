import type { GitHubClient } from "@/github-core/client"
import {
  addUserToTeam,
  createGitCommit,
  createGitTree,
  ensureClassroomRoleTeam,
  grantTeamConfigRepoWrite,
  readOrgMembershipState,
  removeUserFromTeam,
  setOrgMembershipRole,
  updateRef,
} from "@/github-core/mutations"
import { getErrorMessage } from "@/github-core/errorMessage"
import { withGitConflictRetry, assertClassroomNotArchived } from "../classrooms"
import {
  getRawFileWithFallbackSource,
  listAllOrgMembers,
  listOrgAdmins,
  listTeamMembers,
} from "@/github-core/queries"
import { getAuthenticatedUser } from "@/domain/queries/users"
import {
  getBranchRef,
  getCommit,
  getConfigRepoBranch,
} from "@/github-core/configRepoReads"
import { isSameGitHubUser } from "@/util/students"
import { prefixCommit } from "@/util/commit"
import {
  formatRosterProblems,
  parseRosterCsv,
  stringifyStudentsCsv,
} from "@/util/rosterCsv"
import { rosterPath, legacyRosterPath } from "@/util/rosterPath"
import { type ClassroomRole } from "@/util/teamRoster"
import { memberIdentitySets } from "@/util/identity"
import {
  classifyRosterUpload,
  membershipLookup,
  type PreflightResult,
  type PreflightRow,
  type ResolvedMembership,
} from "@/util/rosterUploadPreflight"
import {
  log,
  rosterWriteTree,
  resolveClassroomTeamSlug,
  resolveClassroomTeamSlugs,
  RosterCsvMalformedError,
} from "./rosterPrimitives"

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

  return withGitConflictRetry(async () => {
    const configBranch = await getConfigRepoBranch(client, org)
    const ref = await getBranchRef(client, org, configBranch)
    const commit = await getCommit(client, org, ref.object.sha)
    const studentsFilePath = rosterPath(classroom)
    const currentCsv = await getRawFileWithFallbackSource(client, {
      org,
      path: studentsFilePath,
      fallbackPath: legacyRosterPath(classroom),
      ref: ref.object.sha,
    })
    // Parse tolerantly: a role writeback must not throw an opaque error on a
    // malformed sibling row (the exact self-healing case this feature targets).
    // But we refuse to rewrite a file we can't fully parse — re-serializing
    // positionally would corrupt the malformed row — so raise a TYPED error the
    // caller can surface as "fix roster.csv, then re-check" instead of silently
    // dropping the role. The role still converges on the next clean sync.
    const { rows: currentStudents, problems } = parseRosterCsv(
      currentCsv.content,
    )
    if (problems.length > 0) {
      throw new RosterCsvMalformedError(formatRosterProblems(problems))
    }

    let changed = 0
    const nextStudents = currentStudents.map((s) => {
      const role = roleByLogin.get(s.username.trim().toLowerCase())
      if (role && role !== s.role) {
        changed++
        return { ...s, role }
      }
      return s
    })

    if (changed === 0) return { changed: 0 }

    const nextCsv = stringifyStudentsCsv(nextStudents)
    const tree = await createGitTree(client, {
      org,
      base_tree: commit.tree.sha,
      tree: rosterWriteTree(classroom, nextCsv, currentCsv.fromLegacy),
    })
    const newCommit = await createGitCommit(client, {
      org,
      message: prefixCommit(
        `Set role on ${changed} roster member${changed === 1 ? "" : "s"}: ${classroom}`,
      ),
      tree_sha: tree.sha,
      parents: [ref.object.sha],
    })
    await updateRef(client, org, newCommit.sha, configBranch)
    log.info("write roster roles: committed", { org, classroom, changed })
    return { changed }
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

// Preflight a CSV roster upload: read the classroom's CURRENT GitHub membership
// (all active org members + the three per-classroom team memberships) once, then
// classify each uploaded row (pure, via classifyRosterUpload) into no-action /
// invite / enroll / role-change. Read-only — sends NOTHING to GitHub — so the
// upload dialog can preview the plan and gate role changes behind confirmation.
//
// The team reads 404-tolerate (an uncreated staff team reads as empty), and the
// org-member read pages to completion; a hard failure of either propagates so
// the caller surfaces "couldn't preview, try again" rather than a wrong plan.
export async function resolveRosterUploadPreflight(
  client: GitHubClient,
  input: ResolveRosterUploadPreflightInput,
): Promise<PreflightResult> {
  const { org, classroom, rows } = input
  const slugs = await resolveClassroomTeamSlugs(client, org, classroom)

  const [orgMembers, studentMembers, instructorMembers, taMembers] =
    await Promise.all([
      listAllOrgMembers(client, org),
      listTeamMembers(client, org, slugs.student),
      listTeamMembers(client, org, slugs.staff.instructor),
      listTeamMembers(client, org, slugs.staff.ta),
    ])

  const orgSets = memberIdentitySets(orgMembers)
  const studentSets = memberIdentitySets(studentMembers)
  const instructorSets = memberIdentitySets(instructorMembers)
  const taSets = memberIdentitySets(taMembers)

  const resolved: ResolvedMembership = {
    orgMemberIds: orgSets.ids,
    orgMemberLogins: orgSets.logins,
    teamIdsByRole: {
      student: studentSets.ids,
      instructor: instructorSets.ids,
      ta: taSets.ids,
    },
    teamLoginsByRole: {
      student: studentSets.logins,
      instructor: instructorSets.logins,
      ta: taSets.logins,
    },
  }

  return classifyRosterUpload(rows, membershipLookup(resolved))
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
// as `role_change` or `enroll` and — for an instructor target or a demotion off
// instructor — the teacher confirmed, since it grants/revokes org-OWNER.
//
// Ordering is chosen so a mid-sequence failure never leaves ELEVATED access
// dangling:
//  0) Before any change, refuse an org-OWNER revocation that would be
//     self-inflicted or strip the last owner (self-demotion / sole-owner
//     demotion) — both are unrecoverable-in-place, so they're blocked outright.
//  1) Demote org owner -> member FIRST when leaving instructor for a
//     non-instructor role. Done before any team change, so if it throws we abort
//     with the member unchanged (still instructor + owner) rather than
//     half-moved-but-still-owner. If a LATER step fails after this committed,
//     the error explicitly says the owner was revoked so the caller re-runs.
//  2) Add to the target team (student -> classroom team; ta/instructor -> the
//     staff team, created + granted config-repo write if missing), then promote
//     to org owner when the target is instructor.
//  3) Remove from EVERY currently-held classroom team that isn't the target
//     (best-effort — a failed drop is a warning, since the target add + any
//     owner change already landed). Dropping all non-target teams (not just the
//     primary) means a member on both the instructor and TA teams moved to
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

  const wasInstructor = fromRoles.includes("instructor")
  const demotesOwner = wasInstructor && toRole !== "instructor"

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
        `You can't demote yourself from instructor here — it would revoke ` +
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
          `from instructor — promote another owner first.`,
      )
    }
  }

  // 1) Demote org owner FIRST when leaving instructor for a non-instructor role.
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
    // then promote to org owner for an instructor target.
    if (toRole === "student") {
      await addUserToTeam(client, {
        org,
        teamSlug: slugs.student,
        username,
        role: "member",
      })
    } else {
      const team = await ensureClassroomRoleTeam(client, org, classroom, toRole)
      await grantTeamConfigRepoWrite(client, org, team.slug)
      await addUserToTeam(client, {
        org,
        teamSlug: team.slug,
        username,
        role: "member",
      })
    }
    if (toRole === "instructor") {
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
    await grantTeamConfigRepoWrite(client, org, teamSlug)
  }

  await addUserToTeam(client, { org, teamSlug, username, role: "member" })
  return { state: "assigned", role }
}
