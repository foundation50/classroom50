import type { GitHubClient } from "@/github-core/client"
import {
  createGitCommit,
  createGitTree,
  createOrgInvitation,
  ensureOrgMembership,
  isActiveMember,
  updateRef,
} from "@/github-core/mutations"
import { getErrorMessage } from "@/github-core/errorMessage"
import {
  withGitConflictRetry,
  assertClassroomNotArchived,
  type CreateClassroomResult,
} from "../classrooms"
import { getRawFileWithFallbackSource, getUser } from "@/github-core/queries"
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
import { rosterPath, legacyRosterPath } from "@/util/rosterPath"
import {
  log,
  rosterWriteTree,
  resolveClassroomTeam,
  resolveClassroomTeamWithRetry,
  tryAddUserToTeam,
  StudentAlreadyEnrolledError,
} from "./rosterPrimitives"

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

  const currentCsv = await getRawFileWithFallbackSource(client, {
    org: input.org,
    path: studentsFilePath,
    fallbackPath: legacyRosterPath(input.classroom),
    ref: ref.object.sha,
  })

  const githubUser = await getUser(client, normalizedUsername)
  const currentStudents = parseStudentsCsv(currentCsv.content)

  const alreadyExists = currentStudents.some(
    (student) =>
      student.username.toLowerCase() === githubUser.login.toLowerCase() ||
      student.github_id === String(githubUser.id),
  )

  if (alreadyExists) {
    throw new StudentAlreadyEnrolledError(githubUser.login)
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
    tree: rosterWriteTree(input.classroom, nextCsv, currentCsv.fromLegacy),
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
}

export type InviteByEmailResult = {
  // Set when the invite couldn't be sent as intended (non-fatal, surfaced to
  // the teacher). Undefined on a clean invite.
  inviteWarning?: string
}

// Send a GitHub org invite for an email, attaching the classroom team so the
// student lands in it on acceptance. Writes NOTHING to roster.csv: the team
// is the source of truth for enrollment, and an email carries no reliable
// GitHub identity (it changes to a login only once accepted). The invite shows
// up in the roster's `pending` section via the org pending-invitations list; to
// capture name/section metadata, add the student by GitHub username or upload a
// roster CSV once they've joined. If the classroom team can't be resolved, the
// invite is BLOCKED (throws) rather than sent team-less — see below.
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
  // in the org with no team and (since we write no CSV row) no roster row,
  // silently uncollected. So block the invite unless we can attach the team.
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

  try {
    await createOrgInvitation(client, {
      org,
      email: normalizedEmail,
      team_ids: [teamId],
    })
  } catch (err) {
    // A 422 means the email already belongs to a member or is already invited.
    // There's no reliable identity to persist, so just tell the teacher to add
    // them by username (which resolves the immutable github_id).
    if (err instanceof GitHubAPIError && err.status === 422) {
      return {
        inviteWarning:
          `${normalizedEmail} already belongs to a member of the ${org} ` +
          `organization (or is already invited), so no new invite was sent. ` +
          `If they should be on this classroom, add them by GitHub username.`,
      }
    }
    log.error("org email invite failed", { err })
    return {
      inviteWarning:
        `Sending the organization invite to ${normalizedEmail} failed ` +
        `(${getErrorMessage(err)}); try again.`,
    }
  }

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
  const inviteeId = Number(result.student.github_id)
  if (Number.isFinite(inviteeId) && inviteeId > 0) {
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
