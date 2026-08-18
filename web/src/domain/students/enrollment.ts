import type { GitHubClient } from "@/github-core/client"
import {
  createGitCommit,
  createGitTree,
  createOrgInvitation,
  deleteInviteTeam,
  ensureInviteTeam,
  ensureOrgMembership,
  isActiveMember,
  updateRef,
  type InviteTeamRef,
} from "@/github-core/mutations"
import { getErrorMessage } from "@/github-core/errorMessage"
import {
  withGitConflictRetry,
  assertClassroomNotArchived,
  type CreateClassroomResult,
} from "../classrooms"
import { getRawFile, getUser } from "@/github-core/queries"
import { getAuthenticatedUser } from "../queries/users"
import {
  getBranchRef,
  getCommit,
  getConfigRepoBranch,
} from "@/github-core/configRepoReads"
import { GitHubAPIError } from "@/github-core/errors"
import { prefixCommit } from "@/util/commit"
import {
  normalizeStudentRow,
  splitName,
  parseStudentsCsv,
  stringifyStudentsCsv,
  type StudentCsvRow,
} from "@/util/rosterCsv"
import { rosterPath } from "@/util/rosterPath"
import { resolveGitHubId } from "@/util/students"
import {
  appendEmailInviteRows,
  log,
  rosterWriteTree,
  resolveClassroomTeam,
  resolveClassroomTeamWithRetry,
  tryAddUserToTeam,
  StudentAlreadyEnrolledError,
} from "./rosterPrimitives"
import i18n from "@/i18n"

export type AddStudentToClassroomResult = CreateClassroomResult & {
  student: StudentCsvRow
  // Set when the row committed but the follow-up team add failed (non-fatal).
  teamWarning?: string
}

export async function addStudentToClassroom(
  client: GitHubClient,
  input: AddStudentToClassroomInput,
): Promise<AddStudentToClassroomResult> {
  const normalizedUsername = input.username.trim()

  if (!normalizedUsername) {
    throw new Error("GitHub username is required")
  }

  await assertClassroomNotArchived(client, input.org, input.classroom)

  const configBranch = await getConfigRepoBranch(client, input.org)
  const ref = await getBranchRef(client, input.org, configBranch)
  const commit = await getCommit(client, input.org, ref.object.sha)

  const studentsFilePath = rosterPath(input.classroom)

  const currentCsv = await getRawFile(client, {
    org: input.org,
    path: studentsFilePath,
    ref: ref.object.sha,
  })

  const githubUser = await getUser(client, normalizedUsername)
  const currentStudents = parseStudentsCsv(currentCsv)

  const alreadyExists = currentStudents.some(
    (student) =>
      student.username.toLowerCase() === githubUser.login.toLowerCase() ||
      student.github_id === String(githubUser.id),
  )

  if (alreadyExists) {
    throw new StudentAlreadyEnrolledError(githubUser.login)
  }

  const studentEmailClaim = (input.email ?? "").trim().toLowerCase()
  // Refuse to write a SECOND row carrying an address another row already holds.
  // The common way in: email-invite alice@x, then add the same person by username
  // with that address. Two rows then share it, and updateStudent's clash guard
  // refuses every later email edit for either of them — a dead end the teacher
  // can't see the cause of. Naming the pending invitation makes the fix obvious.
  // (The bulk/CSV path is deliberately not gated here: blocking a whole import on
  // one collision is worse than the duplicate, and its preview already reports
  // addresses the roster claims.)
  if (studentEmailClaim) {
    const claimant = currentStudents.find(
      (student) => student.email.trim().toLowerCase() === studentEmailClaim,
    )
    if (claimant) {
      throw new Error(
        `${input.email?.trim()} is already on this classroom's roster` +
          (claimant.username
            ? ` for @${claimant.username}`
            : ` as a pending email invitation`) +
          `. Add ${githubUser.login} without an email, or cancel that invitation first.`,
      )
    }
  }

  const nameParts = splitName(githubUser.name)

  const studentEmail = input.email?.trim() ?? githubUser.email ?? ""

  const student: StudentCsvRow = normalizeStudentRow({
    username: githubUser.login,
    first_name: input.first_name?.trim() ?? nameParts.first_name,
    last_name: input.last_name?.trim() ?? nameParts.last_name,
    email: studentEmail,
    section: input.section?.trim() ?? "",
    github_id: String(githubUser.id),
  })

  const nextStudents = [...currentStudents, student]
  const nextCsv = stringifyStudentsCsv(nextStudents)

  const tree = await createGitTree(client, {
    org: input.org,
    base_tree: commit.tree.sha,
    tree: rosterWriteTree(input.classroom, nextCsv),
  })

  const newCommit = await createGitCommit(client, {
    org: input.org,
    message: prefixCommit(
      `Add student: ${input.classroom}/${student.username}`,
    ),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
  })

  const updatedRef = await updateRef(
    client,
    input.org,
    newCommit.sha,
    configBranch,
  )

  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha: tree.sha,
    newCommitSha: newCommit.sha,
    updatedRef,
    student,
  }
}

export async function addStudentToClassroomWithConflictRetry(
  client: GitHubClient,
  input: AddStudentToClassroomInput,
) {
  return withGitConflictRetry(() => addStudentToClassroom(client, input))
}

type AddEmailInviteToClassroomInput = {
  org: string
  classroom: string
  email: string
  // Written onto the pending row at invite time. The student has no account yet,
  // so nothing downstream can recover these — the acceptance fold only fills in
  // identity, and a re-upload of the same address is skipped as already claimed.
  first_name?: string
  last_name?: string
  section?: string
}

export type InviteByEmailResult = {
  // Set when the invite couldn't be sent as intended (non-fatal, surfaced to
  // the teacher). Undefined on a clean invite.
  inviteWarning?: string
}

// Send a GitHub org invite for an email, attaching the classroom team so the
// student lands in it on acceptance, PLUS a per-invite secret metadata team
// (invite-<hash(classroom,email)>) whose description retains the invited email
// (PII-minimal: email only). On success it also retains the address on the
// roster as an email-only PENDING row (no username/github_id yet) — that row
// lives exactly as long as its invite team does: the reconcile fills in the
// account identity on acceptance and removes the row once the invite is
// cancelled, expired, or GC'd.
// On acceptance the invitee lands on both teams; a later reconcile pass recovers
// the email <-> account mapping from the metadata team and folds it into
// roster.csv. The invite also shows up in the roster's `pending` section via the
// classroom team's own pending-invitation list — it carries that team, which is
// what scopes it to this classroom. The invite is BLOCKED (throws) unless BOTH
// teams are ready: an invite that can't carry the classroom team would land the
// student in the org with nothing to collect them, and one without its metadata
// team would silently lose the address it was sent to. Nothing has been sent at
// that point, so the teacher just retries.
export async function inviteByEmail(
  client: GitHubClient,
  input: AddEmailInviteToClassroomInput,
): Promise<InviteByEmailResult> {
  const { org, classroom } = input
  const normalizedEmail = input.email.trim()
  if (!normalizedEmail) {
    throw new Error("Email is required")
  }

  await assertClassroomNotArchived(client, org, classroom)

  // Resolve the classroom team id up front: in a team-authoritative model, an
  // invite that can't carry the team is broken — the accepted student would land
  // in the org with no team and, since the pending row carries no identity
  // until acceptance, no collectable roster row either. So block the invite
  // unless we can attach the team.
  // resolveClassroomTeamWithRetry returns id: undefined only for a genuine
  // missing team block (no throw); a TRANSIENT read failure is retried and then
  // propagates as its own error, so a brief GitHub blip surfaces "try again"
  // rather than the misleading "re-run classroom setup" block below.
  const teamId = (await resolveClassroomTeamWithRetry(client, org, classroom))
    .id
  if (!teamId) {
    throw new Error(
      `Couldn't resolve the classroom team for ${classroom}, so no invite was ` +
        `sent. Make sure the classroom's GitHub team exists (re-run classroom ` +
        `setup if needed), then try again.`,
    )
  }

  // The metadata team is a precondition, not a nicety: it's the only thing that
  // retains the invited address, so an invite without it would go out with the
  // email silently dropped. Nothing has been sent yet, so failing here costs a
  // retry rather than a stranded invitation.
  const actor = await getAuthenticatedUser(client)
  let inviteTeam: InviteTeamRef
  try {
    inviteTeam = await ensureInviteTeam(
      client,
      org,
      { email: normalizedEmail, classroom },
      actor.login,
    )
  } catch (err) {
    log.error("invite metadata team create failed", { err })
    throw new Error(
      i18n.t("students.inviteMetadataFailed", {
        email: normalizedEmail,
        message: getErrorMessage(err),
      }),
      { cause: err },
    )
  }
  const teamIds = [teamId, inviteTeam.id]

  // A doomed invite must not leave a fresh, member-less metadata team behind
  // (an orphan holding an email GC can't yet reap). Only a team THIS call
  // created is deleted — an adopted one may hold a prior accepted invite's
  // still-unrecovered record.
  const cleanupInviteTeam = async () => {
    if (!inviteTeam.created) return
    try {
      await deleteInviteTeam(client, org, inviteTeam.slug)
    } catch (err) {
      // Best-effort: a leftover team is only an orphan awaiting GC.
      log.error("invite metadata team cleanup failed", { err })
    }
  }

  try {
    await createOrgInvitation(client, {
      org,
      email: normalizedEmail,
      team_ids: teamIds,
    })
  } catch (err) {
    // A 422 means the email already belongs to a member or is already invited.
    // There's no reliable identity to persist, so just tell the teacher to add
    // them by username (which resolves the immutable github_id).
    if (err instanceof GitHubAPIError && err.status === 422) {
      await cleanupInviteTeam()
      return {
        inviteWarning:
          `${normalizedEmail} already belongs to a member of the ${org} ` +
          `organization (or is already invited), so no new invite was sent. ` +
          `If they should be on this classroom, add them by GitHub username.`,
      }
    }
    log.error("org email invite failed", { err })
    await cleanupInviteTeam()
    return {
      inviteWarning:
        `Sending the organization invite to ${normalizedEmail} failed ` +
        `(${getErrorMessage(err)}); try again.`,
    }
  }

  // Retain the invited email on the roster right away, with whatever name and
  // section the teacher typed: the student has no account yet, so nothing else can
  // recover those later (a re-upload of the same address is skipped as already
  // claimed). Best-effort (never throws); on a miss the accepted invite's
  // reconcile fold appends the row instead.
  await appendEmailInviteRows(client, { org, classroom }, [
    {
      email: normalizedEmail,
      role: "student",
      first_name: input.first_name,
      last_name: input.last_name,
      section: input.section,
    },
  ])

  return {}
}

export type AddStudentToClassroomInput = {
  org: string
  classroom: string
  username: string

  first_name?: string
  last_name?: string
  email?: string
  section?: string
  // Student is already an active org member: skip the invite and drive the
  // team-add / optimistic-seed path. Not written to the roster row.
  enrolled?: boolean
}
export async function enrollStudentInClassroom(
  client: GitHubClient,
  input: AddStudentToClassroomInput,
) {
  const { org, classroom } = input
  log.info("enroll student: started", { org, classroom })
  await assertClassroomNotArchived(client, org, classroom)
  // Resolve the classroom team (slug + id) once, concurrently with the commit.
  // Can reject on a transient read; attach a catch to avoid an unhandled
  // rejection.
  const teamPromise = resolveClassroomTeam(client, org, classroom)
  teamPromise.catch(() => {})

  // Already an active member -> skip the org invite and add to the team
  // directly (an invite would be a no-op, so reconcile would never confirm
  // them). Best-effort: a failed read falls back to sending the invite.
  const normalizedUsername = input.username.trim()
  const alreadyMember = await isActiveMember(client, org, normalizedUsername)

  const result = await addStudentToClassroomWithConflictRetry(client, {
    ...input,
    enrolled: alreadyMember,
  })
  log.info("enroll student: roster row committed", {
    org,
    classroom,
    enrolled: alreadyMember,
  })

  // CLI order: roster row -> membership -> team. Membership/team failures are
  // non-fatal warnings since the commit already landed.
  const warnings: string[] = []

  // Ensure org membership via the resolved github_id. Pass the classroom team id
  // so the invite carries it: accepting the single org invitation activates team
  // membership too (else a separate team-add leaves the student team-pending
  // until they accept a second invite). ensureOrgMembership swallows the benign
  // already-member/already-pending 422.
  const inviteeId = resolveGitHubId(result.student.github_id)
  if (inviteeId !== null) {
    try {
      const teamId = (await teamPromise).id
      await ensureOrgMembership(client, {
        org,
        username: result.student.username,
        inviteeId,
        teamIds: teamId ? [teamId] : undefined,
      })
    } catch (err) {
      log.error("org invite failed (student enrolled)", { err })
      const detail = getErrorMessage(err)
      warnings.push(
        `${result.student.username} was added to the roster, but sending their ` +
          `organization invite failed (${detail}); re-send it from the roster.`,
      )
    }
  }

  // Fallback team-add: covers an already-org-member student (where the invite
  // above was a no-op carrying no team_ids). Idempotent.
  let enrollTeamFailed: string | undefined
  try {
    const teamSlug = (await teamPromise).slug
    const added = await tryAddUserToTeam(
      client,
      { org, teamSlug, username: result.student.username },
      "student enrolled",
    )
    if (!added.ok) enrollTeamFailed = added.detail
  } catch (err) {
    // Slug resolution failed (not the add itself).
    log.error("team resolve failed (student enrolled)", { err })
    enrollTeamFailed = getErrorMessage(err)
  }
  if (enrollTeamFailed) {
    warnings.push(
      `${result.student.username} was added to the roster, but adding them to ` +
        `the classroom team failed (${enrollTeamFailed}); they won't have read on private ` +
        `templates until it's retried.`,
    )
  }

  log.info("enroll student: completed", {
    org,
    classroom,
    warnings: warnings.length,
  })
  return {
    ...result,
    // Whether the student is now an active org member (team-added directly, no
    // invite). The roster view seeds the team-members cache when true to avoid
    // a "not in org" flash; false = the normal invited path.
    enrolled: alreadyMember,
    teamWarning: warnings.length > 0 ? warnings.join(" ") : undefined,
  }
}
