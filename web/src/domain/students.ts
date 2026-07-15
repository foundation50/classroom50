import type { GitHubClient } from "@/github-core/client"
import {
  addUserToTeam,
  cancelOrgInvitation,
  createGitCommit,
  createGitTree,
  createOrgInvitation,
  ensureClassroomRoleTeam,
  ensureOrgMembership,
  getOrgMembershipState,
  grantTeamConfigRepoWrite,
  isActiveMember,
  readOrgMembershipState,
  removeUserFromTeam,
  setOrgMembershipRole,
  updateRef,
  type GitTreeEntry,
} from "@/github-core/mutations"
import { getErrorMessage } from "@/github-core/errorMessage"
import {
  withGitConflictRetry,
  assertClassroomNotArchived,
  type CreateClassroomResult,
} from "./classrooms"
import {
  getRawFile,
  getRawFileWithFallbackSource,
  getUser,
  listAllOrgMembers,
  listOrgAdmins,
  listTeamInvitations,
  listTeamMembers,
  sleep,
  REPO_READ_CONCURRENCY,
} from "@/github-core/queries"
import { getAuthenticatedUser } from "@/domain/queries/users"
import {
  getBranchRef,
  getClassroomJson,
  getCommit,
  getConfigRepoBranch,
} from "@/github-core/configRepoReads"
import {
  GitHubAPIError,
  isDefinitiveGitHubStatus,
  tolerateGitHubError,
} from "@/github-core/errors"
import { isSameGitHubUser, parseGitHubId } from "@/util/students"
import { studentKey, rosterClaimSet } from "@/util/identity"
import { mapWithConcurrency } from "@/util/concurrency"
import { prefixCommit } from "@/util/commit"
import {
  formatRosterProblems,
  normalizeStudentRow,
  parseRosterCsv,
  parseStudentsCsv,
  splitName,
  stringifyStudentsCsv,
  type StudentCsvRow,
} from "@/util/rosterCsv"
import { rosterPath, legacyRosterPath } from "@/util/rosterPath"
import {
  ROLE_RANK,
  githubOrgRoleForRole,
  type ClassroomRole,
} from "@/util/teamRoster"
import { classroomTeamSlug } from "@/util/teamSlug"
import { memberIdentitySets } from "@/util/identity"
import {
  classifyRosterUpload,
  membershipLookup,
  type PreflightResult,
  type PreflightRow,
  type ResolvedMembership,
} from "@/util/rosterUploadPreflight"
import { STAFF_ROLES, type StaffRole, type Student } from "@/types/classroom"
import { logger } from "@/lib/logger"

const log = logger.scope("mutations:students")

// Git-tree entries for a roster write: the roster.csv blob, plus — when
// `fromLegacy` (from getRawFileWithFallbackSource) — a delete of the legacy
// path, so a first edit of an un-migrated classroom converges it in one commit
// (matching `gh teacher roster migrate`) instead of leaving a stale copy.
function rosterWriteTree(
  classroom: string,
  csv: string,
  fromLegacy: boolean,
): GitTreeEntry[] {
  const tree: GitTreeEntry[] = [
    { path: rosterPath(classroom), mode: "100644", type: "blob", content: csv },
  ]
  if (fromLegacy) {
    tree.push({
      path: legacyRosterPath(classroom),
      mode: "100644",
      type: "blob",
      sha: null,
    })
  }
  return tree
}

// Slug is authoritative in classroom.json: GitHub may assign a non-derived slug
// on name collision. Only derive on 404/missing team block; propagate transient
// read failures (NOT "no team") so the caller doesn't target a wrong slug.
async function resolveClassroomTeamSlug(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<string> {
  return (await resolveClassroomTeam(client, org, classroom)).slug
}

// Decision input for unenroll's invite cancel: for a pending invitee on THIS
// classroom, find their team-scoped invitation and whether it belongs solely to
// this classroom. GitHub can't remove one team from a multi-team invite (DELETE
// cancels the whole thing), so unenroll only cancels a sole-classroom invite —
// a multi-classroom invite is left intact rather than revoking a sibling
// classroom's onboarding. Fail-safe: any unresolved signal returns
// soleClassroom:false so the caller leaves the invite alone. Never throws.
export type ClassroomPendingInvite = {
  invitationId?: number
  soleClassroom: boolean
}

export async function resolveClassroomPendingInvite(
  client: GitHubClient,
  input: {
    org: string
    classroom: string
    username: string
    teamSlug?: string
  },
): Promise<ClassroomPendingInvite> {
  const { org, classroom, username } = input
  const loginKey = username.trim().toLowerCase()
  if (!loginKey) return { soleClassroom: false }

  try {
    const teamSlug =
      input.teamSlug ?? (await resolveClassroomTeamSlug(client, org, classroom))
    const invites = await listTeamInvitations(client, org, teamSlug)
    const invite = invites.find(
      (i) => i.login?.trim().toLowerCase() === loginKey,
    )
    if (!invite) return { soleClassroom: false }

    // team_count is the invite's TOTAL team span (not just this team). Since the
    // invite is listed under this classroom's team, exactly 1 => solely this
    // classroom. When absent, resolve the team set and require it to be [teamSlug].
    if (typeof invite.team_count === "number") {
      return { invitationId: invite.id, soleClassroom: invite.team_count === 1 }
    }
    if (invite.invitation_teams_url) {
      const teams = await client.request<Array<{ slug?: string }>>(
        invite.invitation_teams_url,
      )
      const wantSlug = teamSlug.toLowerCase()
      const sole =
        teams.length === 1 && teams[0]?.slug?.toLowerCase() === wantSlug
      return { invitationId: invite.id, soleClassroom: sole }
    }
    // Have the invite id but can't confirm span: fail safe, don't cancel.
    return { invitationId: invite.id, soleClassroom: false }
  } catch {
    return { soleClassroom: false }
  }
}

// Unenroll's invite-cancel policy, shared by the single and bulk paths: cancel a
// pending invite only when it belongs solely to this classroom (see
// resolveClassroomPendingInvite); otherwise keep it and warn (a multi-classroom
// invite or an unconfirmable scope must not revoke a sibling classroom's
// onboarding). Returns the non-fatal warning(s) for the caller to collect; never
// throws — a resolve/cancel failure is a warning, not a thrown error, so a
// commit that already landed stays non-fatal. Callers own the self-guard and the
// pending-state gate.
async function cancelSoleClassroomInviteOnUnenroll(
  client: GitHubClient,
  input: {
    org: string
    classroom: string
    // Resolve key — matched against the team invite's login (trimmed/cased there).
    username: string
    // Name shown in warnings; defaults to `username`.
    displayName?: string
    teamSlug?: string
    logContext: string
  },
): Promise<string[]> {
  const { org, classroom, username, teamSlug, logContext } = input
  const displayName = input.displayName ?? username
  const invite = await resolveClassroomPendingInvite(client, {
    org,
    classroom,
    username,
    teamSlug,
  })

  if (!invite.soleClassroom || invite.invitationId === undefined) {
    return [
      `${displayName} was removed from this classroom, but their pending ` +
        `organization invite was kept because it also grants access to other ` +
        `classrooms (or its scope couldn't be confirmed). Cancel it from the ` +
        `organization's people page if it's no longer needed.`,
    ]
  }

  try {
    await cancelOrgInvitation(client, {
      org,
      invitationId: invite.invitationId,
    })
    return []
  } catch (err) {
    log.error(logContext, { err })
    return [
      `${displayName} was removed from the roster, but cancelling their ` +
        `pending org invite failed (${getErrorMessage(err)}); retry from the ` +
        `organization's people page.`,
    ]
  }
}

// Slug + numeric id from a single classroom.json read (404 -> derived slug,
// other errors propagate; id is undefined when absent).
async function resolveClassroomTeam(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<{ slug: string; id?: number }> {
  try {
    const classroomJson = await getClassroomJson(client, { org, classroom })
    if (classroomJson.team?.slug) {
      return { slug: classroomJson.team.slug, id: classroomJson.team.id }
    }
  } catch (err) {
    if (!(err instanceof GitHubAPIError && err.isNotFound)) {
      throw err
    }
  }
  return { slug: classroomTeamSlug(classroom) }
}

// Read-only resolution of the GitHub team id for a role from classroom.json —
// NO team creation (unlike resolveTeamIdByRole, which ensures/creates staff
// teams). Used by resend, which must re-attach the invitee's existing team
// without the side effect of creating an empty staff team. Returns undefined
// when classroom.json has no id for that role (a blip propagates via
// resolveClassroomTeam for the student role; staff refs are read directly).
export async function resolveTeamIdForRoleRead(
  client: GitHubClient,
  org: string,
  classroom: string,
  role: ClassroomRole,
): Promise<number | undefined> {
  if (role === "student") {
    return (await resolveClassroomTeam(client, org, classroom)).id
  }
  return tolerateGitHubError(async () => {
    const classroomJson = await getClassroomJson(client, { org, classroom })
    return classroomJson.teams?.[role]?.id
  }, undefined)
}

// Resolve the classroom team, retrying only TRANSIENT read failures (5xx / 429 /
// network). A genuine "no team block" returns id: undefined without throwing
// (handled inside resolveClassroomTeam), so it is NOT retried; a transient blip
// is retried a couple of times and then propagates as a real error, so callers
// can tell "the team doesn't exist" apart from "GitHub was briefly unreachable".
async function resolveClassroomTeamWithRetry(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<{ slug: string; id?: number }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await resolveClassroomTeam(client, org, classroom)
    } catch (err) {
      const definitive =
        err instanceof GitHubAPIError && isDefinitiveGitHubStatus(err.status)
      if (definitive || attempt >= 2) throw err
      await sleep(300 * (attempt + 1) + Math.random() * 200)
    }
  }
}

export type AddStudentToClassroomResult = CreateClassroomResult & {
  student: StudentCsvRow
  // Set when the row committed but the follow-up team add failed (non-fatal).
  teamWarning?: string
}

// Already on this classroom's roster (matched by login or github_id). Typed so
// the UI can branch on it instead of string-matching this message.
export class StudentAlreadyEnrolledError extends Error {
  login: string
  constructor(login: string) {
    super(`Student already exists: ${login}`)
    this.name = "StudentAlreadyEnrolledError"
    this.login = login
  }
}

// Best-effort single-user team add (enroll/mark/match paths). Returns the error
// detail on failure so each caller phrases its own warning; team membership is
// only read access to private templates and is retryable, so it never fails the
// enclosing mutation. `context` is a server-log label.
async function tryAddUserToTeam(
  client: GitHubClient,
  input: { org: string; teamSlug: string; username: string },
  context: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    await addUserToTeam(client, {
      org: input.org,
      teamSlug: input.teamSlug,
      username: input.username,
      role: "member",
    })
    return { ok: true }
  } catch (err) {
    log.error(`team add failed (${context})`, { err })
    return { ok: false, detail: getErrorMessage(err) }
  }
}

// The roster.csv parse/serialize layer lives in util/rosterCsv (pure, no
// GitHubClient dependency). Re-exported here so existing importers of these
// symbols from "@/domain/students" keep working unchanged.
export {
  STUDENT_CSV_FIELDS,
  normalizeStudentRow,
  splitName,
  parseRosterCsv,
  formatRosterProblems,
  parseStudentsCsv,
  stringifyStudentsCsv,
} from "@/util/rosterCsv"
export type {
  StudentCsvRow,
  RosterCsvProblem,
  ParsedRosterCsv,
} from "@/util/rosterCsv"

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

type AddStudentToClassroomInput = {
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

type BulkImportProgress = {
  processed: number
  total: number
  message: string
}

// A parsed roster-upload row. Only username is required; the rest is optional
// metadata. github_id is intentionally NOT taken from the file — it's re-derived
// from GitHub so the stored id is always authoritative.
export type ImportRosterRow = {
  username: string
  first_name?: string
  last_name?: string
  email?: string
  section?: string
  // Classroom role from an optional `role` column, validated to a ClassroomRole.
  // Undefined when absent or unrecognized; the upload defaults it to "student"
  // and lets the instructor override per row before inviting.
  role?: ClassroomRole
}

export type AddStudentsToClassroomInput = {
  org: string
  classroom: string
  // Full metadata rows (preferred). When omitted, `usernames` is used as
  // username-only rows. Exactly one should be provided.
  rows?: ImportRosterRow[]
  usernames?: string[]
  onProgress?: (progress: BulkImportProgress) => void
}

export type AddStudentsToClassroomResult = CreateClassroomResult & {
  addedStudents: StudentCsvRow[]
  skippedStudents: {
    username: string
    reason: "duplicate" | "not_found" | "invalid" | "error"
    message?: string
  }[]
}

export const normalizeGithubUsername = (username: string) => {
  return username.trim().replace(/^@/, "")
}

export const isLikelyGithubUsername = (username: string) => {
  // alphanumeric + hyphens, no hyphens at start or end
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(username)
}

// Thrown by addStudentsToClassroom when every candidate row is a duplicate or
// invalid, so there is nothing to commit. A typed sentinel (not a bare Error)
// so a caller like the roster upload can detect the benign "all rows already
// present" re-run and still proceed to its invite pass, while other callers
// keep surfacing it as a hard "nothing to add."
export class NoNewStudentsError extends Error {
  constructor() {
    super("No new students to add")
    this.name = "NoNewStudentsError"
  }
}

export async function addStudentsToClassroom(
  client: GitHubClient,
  input: AddStudentsToClassroomInput,
): Promise<AddStudentsToClassroomResult> {
  // Unify rows/usernames into metadata rows, deduped by lowercased username
  // (first occurrence wins, so its metadata is kept).
  const rawRows: ImportRosterRow[] =
    input.rows ?? (input.usernames ?? []).map((username) => ({ username }))
  const normalizedRows = Array.from(
    new Map(
      rawRows
        .map((row) => ({
          ...row,
          username: normalizeGithubUsername(row.username),
        }))
        .filter((row) => row.username)
        .map((row) => [row.username.toLowerCase(), row]),
    ).values(),
  )

  if (normalizedRows.length === 0) {
    throw new Error("At least one GitHub username is required")
  }

  log.info("bulk add students: started", {
    org: input.org,
    classroom: input.classroom,
    total: normalizedRows.length,
  })

  await assertClassroomNotArchived(client, input.org, input.classroom)

  input.onProgress?.({
    processed: 0,
    total: normalizedRows.length,
    message: "Reading current roster.csv...",
  })

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

  const currentStudents = parseStudentsCsv(currentCsv.content)

  const existingUsernameKeys = new Set(
    currentStudents.map((student) => student.username.toLowerCase()),
  )

  const existingGithubIds = new Set(
    currentStudents.map((student) => student.github_id).filter(Boolean),
  )

  const skippedStudents: AddStudentsToClassroomResult["skippedStudents"] = []
  const addedStudents: StudentCsvRow[] = []

  let processed = 0

  for (const row of normalizedRows) {
    const username = row.username
    input.onProgress?.({
      processed,
      total: normalizedRows.length,
      message: `Checking ${username}...`,
    })

    if (!isLikelyGithubUsername(username)) {
      skippedStudents.push({
        username,
        reason: "invalid",
        message: "Invalid GitHub username",
      })

      processed++
      continue
    }

    // Dedupe by login (pre-resolution). Dedupe by github_id happens after the
    // GitHub lookup, since the file may store a stale/renamed login.
    if (existingUsernameKeys.has(username.toLowerCase())) {
      skippedStudents.push({
        username,
        reason: "duplicate",
        message: "Student is already in roster.csv",
      })

      processed++
      continue
    }

    try {
      const githubUser = await getUser(client, username)

      if (existingGithubIds.has(String(githubUser.id))) {
        skippedStudents.push({
          username: githubUser.login,
          reason: "duplicate",
          message: "Student GitHub ID is already in roster.csv",
        })

        processed++
        continue
      }

      // Metadata: prefer the uploaded row, fall back to the GitHub profile.
      const nameParts = splitName(githubUser.name)
      const first_name = row.first_name?.trim() || nameParts.first_name
      const last_name = row.last_name?.trim() || nameParts.last_name
      const email = row.email?.trim() || githubUser.email || ""

      const student = normalizeStudentRow({
        username: githubUser.login,
        first_name,
        last_name,
        email,
        section: row.section?.trim() ?? "",
        github_id: String(githubUser.id),
      })

      existingUsernameKeys.add(student.username.toLowerCase())
      existingGithubIds.add(student.github_id)
      addedStudents.push(student)
    } catch (err) {
      log.debug("bulk add: user lookup failed, skipping row", {
        username,
        err,
      })
      skippedStudents.push({
        username,
        reason: "not_found",
        message:
          err instanceof Error ? err.message : "Could not fetch GitHub user",
      })
    }

    processed++

    input.onProgress?.({
      processed,
      total: normalizedRows.length,
      message: `Checked ${processed} of ${normalizedRows.length} usernames...`,
    })
  }

  if (addedStudents.length === 0) {
    throw new NoNewStudentsError()
  }

  input.onProgress?.({
    processed,
    total: normalizedRows.length,
    message: "Writing roster.csv...",
  })

  const nextStudents = [...currentStudents, ...addedStudents]
  const nextCsv = stringifyStudentsCsv(nextStudents)

  const tree = await createGitTree(client, {
    org: input.org,
    base_tree: commit.tree.sha,
    tree: rosterWriteTree(input.classroom, nextCsv, currentCsv.fromLegacy),
  })

  const newCommit = await createGitCommit(client, {
    org: input.org,
    message: prefixCommit(
      `Add ${addedStudents.length} student ${
        addedStudents.length === 1 ? "" : "s"
      }: ${input.classroom}`,
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

  input.onProgress?.({
    processed: normalizedRows.length,
    total: normalizedRows.length,
    message: "roster.csv updated.",
  })

  log.info("bulk add students: completed", {
    org: input.org,
    classroom: input.classroom,
    added: addedStudents.length,
    skipped: skippedStudents.length,
  })

  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha: tree.sha,
    newCommitSha: newCommit.sha,
    updatedRef,
    addedStudents,
    skippedStudents,
  }
}

export async function addStudentsToClassroomWithConflictRetry(
  client: GitHubClient,
  input: AddStudentsToClassroomInput,
) {
  return withGitConflictRetry(() => addStudentsToClassroom(client, input))
}

export type SyncRosterFromTeamResult = {
  // Team members newly appended to roster.csv as metadata rows.
  addedUsernames: string[]
  // No missing members and no role changes — nothing was committed.
  noop: boolean
}

// A single classroom member unioned across the student + staff teams, tagged
// with their highest-precedence role (instructor > ta > student).
type MemberWithRole = {
  id: number
  login: string
  email?: string | null
  role: ClassroomRole
}

// Resolve the student-team slug plus the two staff-team slugs from one
// classroom.json read (slugs are authoritative there; GitHub may rewrite them
// on name collision). Falls back to the derived name per team when the block
// is absent — mirroring useTeamRoster's resolution so the sync sees exactly the
// teams the roster view does.
async function resolveClassroomTeamSlugs(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<{ student: string; staff: Record<StaffRole, string> }> {
  let json: Awaited<ReturnType<typeof getClassroomJson>> | null = null
  try {
    json = await getClassroomJson(client, { org, classroom })
  } catch (err) {
    // A missing classroom.json (404) -> derived slugs; a transient failure
    // propagates so we don't sync against a wrong team.
    if (!(err instanceof GitHubAPIError && err.isNotFound)) {
      throw err
    }
  }
  return {
    student: json?.team?.slug || classroomTeamSlug(classroom),
    staff: {
      instructor:
        json?.teams?.instructor?.slug ||
        classroomTeamSlug(classroom, "instructor"),
      ta: json?.teams?.ta?.slug || classroomTeamSlug(classroom, "ta"),
    },
  }
}

// Union the student + staff team memberships into one member-per-github_id map,
// each tagged with their highest-precedence role. A staff team that doesn't
// exist yet (404) lists as empty (listTeamMembers already 404-tolerates), so a
// classroom with no staff team simply contributes no staff rows.
async function listClassroomMembersWithRoles(
  client: GitHubClient,
  org: string,
  slugs: { student: string; staff: Record<StaffRole, string> },
): Promise<{
  members: MemberWithRole[]
  fullyRead: boolean
  // Lowercased logins + emails with a pending invite to ANY classroom team.
  // A pending invitee isn't a team MEMBER yet, so sync must not clear the role
  // it (or an upload writeback) just recorded — the invite already carries that
  // role, and it activates on acceptance. Empty when pending reads degrade, in
  // which case fullyRead is false so the clear path stays conservative anyway.
  pendingRoleKeys: Set<string>
}> {
  // The student read stays strict (a transient failure there fails the sync so
  // it retries against fresh state). The two staff reads are best-effort: a
  // flaky or permission-blocked staff team degrades to [] rather than blocking
  // an otherwise-fine student sync — listTeamMembers already treats a missing
  // team (404) as [], so only a non-404 reject reaches the settle here.
  //
  // `fullyRead` is false when any staff or pending read was degraded, so the
  // caller must NOT treat "absent from this list" as "on no team" (that would
  // wipe an active staffer's role from an incomplete picture). Appends are
  // still safe from a partial list; only the role-CLEAR path is gated on it.
  const allSlugs = [slugs.student, ...STAFF_ROLES.map((r) => slugs.staff[r])]
  const [studentMembers, staffSettled, pendingSettled] = await Promise.all([
    listTeamMembers(client, org, slugs.student),
    Promise.all(
      STAFF_ROLES.map((role) =>
        Promise.allSettled([
          listTeamMembers(client, org, slugs.staff[role]),
        ]).then(([r]) => r),
      ),
    ),
    // Pending invitations per team (owner-only; 404 -> [], other errors settle
    // to a rejection we treat as a degraded read).
    Promise.all(
      allSlugs.map((slug) =>
        Promise.allSettled([listTeamInvitations(client, org, slug)]).then(
          ([r]) => r,
        ),
      ),
    ),
  ])
  const staffFullyRead = staffSettled.every((r) => r.status === "fulfilled")
  const pendingFullyRead = pendingSettled.every((r) => r.status === "fulfilled")
  const fullyRead = staffFullyRead && pendingFullyRead
  const staffMemberLists = staffSettled.map((r) =>
    r.status === "fulfilled" ? r.value : [],
  )

  const pendingRoleKeys = new Set<string>()
  for (const r of pendingSettled) {
    if (r.status !== "fulfilled") continue
    for (const invite of r.value) {
      if (invite.login) pendingRoleKeys.add(invite.login.toLowerCase())
      if (invite.email) pendingRoleKeys.add(invite.email.trim().toLowerCase())
    }
  }

  const byId = new Map<number, MemberWithRole>()
  const consider = (
    member: { id: number; login: string; email?: string | null },
    role: ClassroomRole,
  ) => {
    const existing = byId.get(member.id)
    // Keep the highest-precedence role when a person is on several teams
    // (e.g. an instructor also on the student team records "instructor").
    if (existing && ROLE_RANK[existing.role] >= ROLE_RANK[role]) return
    byId.set(member.id, {
      id: member.id,
      login: member.login,
      email: member.email,
      role,
    })
  }

  for (const m of studentMembers) consider(m, "student")
  STAFF_ROLES.forEach((role, i) => {
    for (const m of staffMemberLists[i]) consider(m, role)
  })

  return { members: [...byId.values()], fullyRead, pendingRoleKeys }
}

// Sync roster.csv from the classroom's GitHub teams: ensure every active member
// of the student, instructor, and ta teams has an IDENTITY row (username +
// github_id) carrying their recorded `role`, and refresh the role on rows whose
// team-derived role has changed — all in ONE commit. The teams are the source
// of truth for enrollment and role; the CSV holds teacher-supplied metadata
// plus this best-effort role snapshot, so this writes identity + role only and
// never fabricates name/email/section from the GitHub profile. Never removes
// rows (CSV-only rows are drift, not deletions).
//
// The diff is recomputed INSIDE the retried closure (re-reading both teams and
// CSV each attempt) so a 409 retry or concurrent edit can't reintroduce or
// duplicate rows. Uses the same github_id -> username -> email fallback join as
// the roster view when deciding "missing", so a pre-resolution row with an
// empty github_id isn't treated as missing (which would append a duplicate).
export async function syncRosterFromTeam(
  client: GitHubClient,
  input: { org: string; classroom: string },
): Promise<SyncRosterFromTeamResult> {
  const { org, classroom } = input
  log.info("sync roster from team: started", { org, classroom })
  await assertClassroomNotArchived(client, org, classroom)

  const slugs = await resolveClassroomTeamSlugs(client, org, classroom)

  return withGitConflictRetry(async () => {
    // Re-read teams + CSV on every attempt so the diff is always against the
    // latest state (a concurrent add/edit can't be clobbered or duplicated).
    const [{ members, fullyRead, pendingRoleKeys }, configBranch] =
      await Promise.all([
        listClassroomMembersWithRoles(client, org, slugs),
        getConfigRepoBranch(client, org),
      ])
    const ref = await getBranchRef(client, org, configBranch)
    const commit = await getCommit(client, org, ref.object.sha)

    const studentsFilePath = rosterPath(classroom)
    const currentCsv = await getRawFileWithFallbackSource(client, {
      org,
      path: studentsFilePath,
      fallbackPath: legacyRosterPath(classroom),
      ref: ref.object.sha,
    })
    const currentStudents = parseStudentsCsv(currentCsv.content)

    const { ids, logins } = rosterClaimSet(currentStudents)
    // Email set mirrors buildTeamRoster's indexCsv.byEmail fold: a member whose
    // GitHub email matches an existing (e.g. pre-resolution, id/login-less) CSV
    // row is the SAME person the view folds by email, so appending would create
    // a duplicate email-colliding row the view masks but that breaks email-keyed
    // logic (match-by-email, invite dedupe).
    const emails = new Set(
      currentStudents
        .map((s) => s.email?.trim().toLowerCase())
        .filter((e): e is string => Boolean(e)),
    )

    // A member is "missing" when their numeric id, login, AND email are all
    // unclaimed by any CSV row (the same id -> login -> email fallback join the
    // roster view uses, so append and display can't diverge).
    const missing = members.filter(
      (m) =>
        !ids.has(String(m.id)) &&
        !logins.has(m.login.toLowerCase()) &&
        !(m.email ? emails.has(m.email.trim().toLowerCase()) : false),
    )

    // Reconcile the recorded role on existing rows to match live team
    // membership — the team is the authority. Matched by id, then login (the
    // same identity join used above):
    //  - on a team now -> set the team-derived primary role (promotion/demotion,
    //    or a first-ever role on a pre-role row);
    //  - on NO team, and every team read SUCCEEDED (fullyRead) -> clear the role
    //    to "" (e.g. a TA removed from the staff team; the stale "ta" must not
    //    linger). When a staff read was degraded (not fullyRead), leave the role
    //    UNCHANGED — "absent from an incomplete read" is not proof of removal, so
    //    a transient staff-team blip must never wipe an active staffer's role.
    // This is the only in-place edit sync makes; name/email/section stay
    // teacher-owned. The row itself is never removed (CSV-only rows are drift,
    // not deletions).
    const roleById = new Map(members.map((m) => [String(m.id), m.role]))
    const roleByLogin = new Map(
      members.map((m) => [m.login.toLowerCase(), m.role]),
    )
    // github_id per login, to backfill a row that carries only a username (the
    // common "teacher wrote a bare username, invited, the student joined" flow).
    // Only usable when a login maps to exactly one member — a duplicate login
    // (shouldn't happen on one team, but be safe) is left un-backfilled rather
    // than guess. An existing non-empty id is NEVER overwritten (a renamed login
    // must not silently repoint an id onto a different account).
    const loginCounts = new Map<string, number>()
    for (const m of members) {
      const k = m.login.toLowerCase()
      loginCounts.set(k, (loginCounts.get(k) ?? 0) + 1)
    }
    const idByLogin = new Map(
      members
        .filter((m) => loginCounts.get(m.login.toLowerCase()) === 1)
        .map((m) => [m.login.toLowerCase(), String(m.id)]),
    )
    let roleChanges = 0
    let idBackfills = 0
    const reconciledStudents = currentStudents.map((s) => {
      const loginKey = s.username.trim().toLowerCase()
      const emailKey = s.email?.trim().toLowerCase()
      const teamRole =
        (s.github_id ? roleById.get(s.github_id.trim()) : undefined) ??
        roleByLogin.get(loginKey)
      // A pending invitee is not a team member yet, so teamRole is undefined —
      // but the invite already carries their role and activates on acceptance.
      // Clearing it here (a fresh upload writeback, or any recorded role) would
      // wipe the role for the whole pending window, so preserve s.role while a
      // pending invite for this login/email exists.
      const hasPendingRole =
        (loginKey && pendingRoleKeys.has(loginKey)) ||
        (emailKey ? pendingRoleKeys.has(emailKey) : false)
      const role = teamRole ?? (fullyRead && !hasPendingRole ? "" : s.role)
      // Backfill only a blank id (see the idByLogin block above).
      const backfilledId =
        !s.github_id.trim() && loginKey ? idByLogin.get(loginKey) : undefined

      let next = s
      if (role !== s.role) {
        roleChanges++
        next = { ...next, role }
      }
      if (backfilledId) {
        idBackfills++
        next = { ...next, github_id: backfilledId }
      }
      return next
    })

    if (missing.length === 0 && roleChanges === 0 && idBackfills === 0) {
      log.info("sync roster from team: completed (up to date)", {
        org,
        classroom,
      })
      return { addedUsernames: [], noop: true }
    }

    // Identity + role rows: username + github_id + role. Name/email/section are
    // left blank for the teacher to provide (via Edit or a roster upload). The
    // teams decide enrollment and role; the CSV holds only teacher-supplied
    // metadata plus this role snapshot, so we never fabricate profile fields
    // from the GitHub account here.
    const addedRows = missing.map((m) =>
      normalizeStudentRow({
        username: m.login,
        first_name: "",
        last_name: "",
        email: "",
        section: "",
        github_id: String(m.id),
        role: m.role,
      }),
    )

    const nextCsv = stringifyStudentsCsv([...reconciledStudents, ...addedRows])

    const tree = await createGitTree(client, {
      org,
      base_tree: commit.tree.sha,
      tree: rosterWriteTree(classroom, nextCsv, currentCsv.fromLegacy),
    })

    const newCommit = await createGitCommit(client, {
      org,
      message: prefixCommit(
        `Sync ${addedRows.length} member${
          addedRows.length === 1 ? "" : "s"
        } into roster: ${classroom}`,
      ),
      tree_sha: tree.sha,
      parents: [ref.object.sha],
    })

    await updateRef(client, org, newCommit.sha, configBranch)

    log.info("sync roster from team: completed", {
      org,
      classroom,
      added: addedRows.length,
      roleChanges,
      idBackfills,
    })
    return {
      addedUsernames: addedRows.map((r) => r.username),
      noop: false,
    }
  })
}

export type WriteClassroomRolesInput = {
  org: string
  classroom: string
  // Usernames -> the role to persist on their roster.csv row. Used by the upload
  // to write an assigned role for a freshly-invited (still-pending) member,
  // whose role auto-sync can't yet derive from team membership.
  roles: { username: string; role: ClassroomRole }[]
}

// A role writeback couldn't run because roster.csv is malformed. Typed so the
// caller can surface "fix the file, then re-check" instead of blanket-swallowing
// a generic parse error — we refuse to rewrite a file we can't fully parse
// (a positional re-serialize would corrupt the malformed row).
export class RosterCsvMalformedError extends Error {
  problemsSummary: string
  constructor(problemsSummary: string) {
    super(
      `roster.csv is malformed, so roles were not written: ${problemsSummary}`,
    )
    this.name = "RosterCsvMalformedError"
    this.problemsSummary = problemsSummary
  }
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

export type MigrateRosterFileResult = {
  // True when a rename commit was made (legacy students.csv -> roster.csv).
  migrated: boolean
}

// Read a config file's bytes, or null on a true 404. A non-404 propagates so a
// transient API failure is never mistaken for "file absent".
async function readFileOrNull(
  client: GitHubClient,
  org: string,
  path: string,
  ref: string,
): Promise<string | null> {
  return tolerateGitHubError(() => getRawFile(client, { org, path, ref }), null)
}

// Converge a classroom bootstrapped before the roster rename onto roster.csv,
// so the file always physically exists. Mirrors the CLI `gh teacher roster
// migrate`: if only the legacy students.csv is present, write roster.csv with
// its bytes verbatim and delete the legacy file in ONE tree commit. Idempotent:
// a no-op when roster.csv already exists, and nothing-to-do when neither file
// is present (a brand-new classroom's roster.csv is created by the team sync
// instead). Runs inside the conflict-retry loop so a concurrent write (e.g. an
// interleaved roster edit) is re-read rather than clobbered.
export async function migrateRosterFile(
  client: GitHubClient,
  input: { org: string; classroom: string },
): Promise<MigrateRosterFileResult> {
  const { org, classroom } = input
  const rosterFilePath = rosterPath(classroom)
  const legacyPath = legacyRosterPath(classroom)

  return withGitConflictRetry(async () => {
    const configBranch = await getConfigRepoBranch(client, org)
    const ref = await getBranchRef(client, org, configBranch)
    const commit = await getCommit(client, org, ref.object.sha)

    // Read both files' presence at the same commit. roster.csv present -> the
    // classroom is already converged (or has both, and roster.csv is canonical);
    // nothing to migrate.
    const [rosterBytes, legacyBytes] = await Promise.all([
      readFileOrNull(client, org, rosterFilePath, ref.object.sha),
      readFileOrNull(client, org, legacyPath, ref.object.sha),
    ])

    if (rosterBytes !== null || legacyBytes === null) {
      // roster.csv already exists, or neither file does — no rename to do.
      return { migrated: false }
    }

    // Only the legacy file exists: write roster.csv with its bytes verbatim and
    // delete the legacy file in a single commit (mode 100644; sha:null deletes).
    const tree = await createGitTree(client, {
      org,
      base_tree: commit.tree.sha,
      tree: rosterWriteTree(classroom, legacyBytes, true),
    })

    const newCommit = await createGitCommit(client, {
      org,
      message: prefixCommit(`Migrate students.csv to roster.csv: ${classroom}`),
      tree_sha: tree.sha,
      parents: [ref.object.sha],
    })

    await updateRef(client, org, newCommit.sha, configBranch)

    log.info("migrate roster file: renamed students.csv -> roster.csv", {
      org,
      classroom,
    })
    return { migrated: true }
  })
}

export type InviteRosterStudentsInput = {
  org: string
  classroom: string
  // Rows to invite. Each carries at least a username (a roster.csv row always
  // has one); github_id is used when present, else derived from the username.
  // `role` (default "student") selects the target team and org role: student ->
  // classroom team, ta -> TA team, instructor -> org OWNER (admin) + instructor
  // team. `pending` rows are handled by resendOrgInvitation, not here.
  students: { username: string; github_id?: string; role?: ClassroomRole }[]
  onProgress?: (progress: {
    processed: number
    total: number
    message: string
  }) => void
  // Injectable sleep for the Retry-After backoff (tests pass a no-op). Defaults
  // to the real sleep.
  sleepFn?: (ms: number) => Promise<void>
  // Max Retry-After-backed retry rounds for the deferred (rate-limited) set.
  maxRetries?: number
}

// Retry a deferred (rate-limited) set with bounded, Retry-After-honoring
// backoff so a transient secondary limit doesn't force a manual re-run. Shared
// by inviteRosterStudents and bulkInviteByEmail (their per-item invite differs;
// the retry machinery does not). `attempt` performs one invite and throws on
// error; `onError` classifies a non-rate-limit failure (each caller records its
// own failed/skipped shape). A still-rate-limited item is re-queued for the
// next round; whatever remains after `maxRetries` is returned as `deferred`.
//
// The honored `Retry-After` is carried FORWARD as a floor across rounds (max of
// the running floor and any freshly-seen header) rather than cleared each round.
// GitHub omits Retry-After on some secondary limits, so clearing it would let a
// headerless repeat 429 collapse the wait back to the ~1s exponential backoff
// and re-hammer a limit the server already told us to wait out.
async function retryDeferred<T>(opts: {
  queue: T[]
  maxRetries: number
  sleepFn: (ms: number) => Promise<unknown>
  // The Retry-After floor (ms) seeded from the first pass's rate-limit errors.
  initialRetryAfterMs: number
  attempt: (item: T) => Promise<void>
  // Handle a non-rate-limit error (the caller records it in its own bucket).
  onError: (item: T, err: unknown) => void
}): Promise<T[]> {
  const { maxRetries, sleepFn, attempt, onError } = opts
  let queue = opts.queue
  let retryAfterMs = opts.initialRetryAfterMs
  for (let round = 0; round < maxRetries && queue.length > 0; round++) {
    const backoffMs = Math.min(8000, 500 * 2 ** round)
    const jitterMs = Math.floor(Math.random() * 250)
    await sleepFn(Math.max(retryAfterMs, backoffMs) + jitterMs)
    const stillDeferred: T[] = []
    for (const item of queue) {
      try {
        await attempt(item)
      } catch (err) {
        if (err instanceof GitHubAPIError && err.isRateLimited) {
          if (err.rateLimit.retryAfter !== null)
            retryAfterMs = Math.max(
              retryAfterMs,
              err.rateLimit.retryAfter * 1000,
            )
          stillDeferred.push(item)
        } else {
          onError(item, err)
        }
      }
    }
    queue = stillDeferred
  }
  return queue
}

export type InviteRosterStudentsResult = {
  // A fresh org invite was created (carrying the role's team). Each carries the
  // role it was invited as, so a caller can write it back to roster.csv.
  invited: { username: string; role: ClassroomRole }[]
  // Already an active member or already had a pending invite — no new invite.
  skipped: { username: string; reason: "already-member" | "already-pending" }[]
  // Couldn't invite (username didn't resolve to a GitHub account, or the invite
  // call failed).
  failed: { username: string; message: string }[]
  // Not attempted because a GitHub rate limit was hit mid-batch — the teacher
  // can retry these later once the limit clears (see the short-circuit below).
  deferred: string[]
}

// Bulk-invite roster members who aren't yet in the organization, by role.
// Resolves each username to its immutable GitHub id (stored github_id when
// present, else GET /users/{username}) and sends a fresh org invitation
// carrying the role's team so accepting it activates the right membership
// atomically: student -> classroom team, ta -> TA team, instructor -> the
// instructor team AND org OWNER (role "admin"). Does NOT write roster.csv
// (writeback is the caller's job) and never touches an existing active/pending
// state (ensureOrgMembership no-ops those, so an existing member is never
// escalated).
export async function inviteRosterStudents(
  client: GitHubClient,
  input: InviteRosterStudentsInput,
): Promise<InviteRosterStudentsResult> {
  const {
    org,
    classroom,
    students,
    onProgress,
    sleepFn = sleep,
    maxRetries = 3,
  } = input
  await assertClassroomNotArchived(client, org, classroom)

  const invited: InviteRosterStudentsResult["invited"] = []
  const skipped: InviteRosterStudentsResult["skipped"] = []
  const failed: InviteRosterStudentsResult["failed"] = []
  const deferred: string[] = []

  const targets = students
    .map((s) => ({
      username: s.username.trim(),
      github_id: s.github_id,
      role: s.role ?? "student",
    }))
    .filter((s) => s.username)
  if (targets.length === 0) return { invited, skipped, failed, deferred }

  // Resolve every role's team id once so a fresh invite carries the right team
  // (accepting the single org invite then activates that membership). A missing
  // team id is tolerated — the invite still sends, just without a team attached.
  const teamIdByRole = await resolveTeamIdByRole(
    client,
    org,
    classroom,
    new Set(targets.map((t) => t.role)),
  )

  let processed = 0
  const bump = (username: string) => {
    processed += 1
    onProgress?.({ processed, total: targets.length, message: username })
  }

  type Target = (typeof targets)[number]

  // Invite one target. Returns its result bucket; throws on error so the caller
  // can classify rate-limit vs failure.
  const inviteOne = async (
    target: Target,
  ): Promise<
    | InviteRosterStudentsResult["invited"][number]
    | { skip: "already-member" | "already-pending" }
  > => {
    const { username, role } = target
    const inviteeId =
      parseGitHubId(target.github_id ?? "") ??
      (await getUser(client, username)).id
    const teamId = teamIdByRole[role]
    const result = await ensureOrgMembership(client, {
      org,
      username,
      inviteeId,
      teamIds: teamId ? [teamId] : undefined,
      role: githubOrgRoleForRole(role),
    })
    if (result.state === "invited") return { username, role }
    return {
      skip: result.state === "active" ? "already-member" : "already-pending",
    }
  }

  // Once GitHub returns a (secondary) rate limit, stop issuing NEW invites this
  // pass: hammering a throttled endpoint only extends the window. Remaining
  // targets are collected as `deferred` and then retried (below) honoring
  // Retry-After. Every error is classified individually so a genuine 429 is
  // always deferred, never mislabeled `failed`.
  let rateLimited = false
  let retryAfterMs = 0
  const deferredTargets: Target[] = []

  await mapWithConcurrency(targets, REPO_READ_CONCURRENCY, async (target) => {
    const { username } = target
    if (rateLimited) {
      deferredTargets.push(target)
      bump(username)
      return
    }
    try {
      const outcome = await inviteOne(target)
      if ("skip" in outcome) skipped.push({ username, reason: outcome.skip })
      else invited.push(outcome)
    } catch (err) {
      if (err instanceof GitHubAPIError && err.isRateLimited) {
        rateLimited = true
        if (err.rateLimit.retryAfter !== null)
          retryAfterMs = Math.max(retryAfterMs, err.rateLimit.retryAfter * 1000)
        deferredTargets.push(target)
      } else {
        failed.push({ username, message: getErrorMessage(err) })
      }
    } finally {
      bump(username)
    }
  })

  // Retry the deferred (rate-limited) set (see retryDeferred).
  const stillDeferred = await retryDeferred({
    queue: deferredTargets,
    maxRetries,
    sleepFn,
    initialRetryAfterMs: retryAfterMs,
    attempt: async (target) => {
      const outcome = await inviteOne(target)
      if ("skip" in outcome)
        skipped.push({ username: target.username, reason: outcome.skip })
      else invited.push(outcome)
    },
    onError: (target, err) =>
      failed.push({ username: target.username, message: getErrorMessage(err) }),
  })
  for (const target of stillDeferred) deferred.push(target.username)

  return { invited, skipped, failed, deferred }
}

// Resolve the team id for each role present in the invite batch: student ->
// classroom team, instructor/ta -> the staff team (created if missing, mirroring
// the Settings staff flow so an instructor/ta invite lands them on the right
// team on acceptance). Only ensures a staff team when that role is actually
// being invited — a students-only upload must not create (and grant config-repo
// write to) empty instructor/ta teams as a side effect. A failed resolve leaves
// that role's id undefined — the invite still sends teamless.
async function resolveTeamIdByRole(
  client: GitHubClient,
  org: string,
  classroom: string,
  rolesPresent: ReadonlySet<ClassroomRole>,
): Promise<Record<ClassroomRole, number | undefined>> {
  const result: Record<ClassroomRole, number | undefined> = {
    student: undefined,
    instructor: undefined,
    ta: undefined,
  }
  if (rolesPresent.has("student")) {
    // resolveClassroomTeam already returns id: undefined on a genuine 404 (no
    // team block) WITHOUT throwing, and propagates a transient read failure —
    // so no catch here: a blip must surface, not be mistaken for "no team".
    result.student = (await resolveClassroomTeam(client, org, classroom)).id
  }
  for (const role of STAFF_ROLES) {
    if (!rolesPresent.has(role)) continue
    try {
      const team = await ensureClassroomRoleTeam(client, org, classroom, role)
      await grantTeamConfigRepoWrite(client, org, team.slug)
      result[role] = team.id
    } catch (err) {
      // Only a DEFINITIVE failure (e.g. 403 no permission to create/grant the
      // staff team) degrades to a teamless invite. A transient 5xx/429/network
      // error must propagate — sending an instructor an org-OWNER invite while
      // silently dropping them off the instructor team is worse than retrying.
      if (
        err instanceof GitHubAPIError &&
        isDefinitiveGitHubStatus(err.status)
      ) {
        result[role] = undefined
      } else {
        throw err
      }
    }
  }
  return result
}

export type BulkInviteByEmailInput = {
  org: string
  classroom: string
  // Emails to invite, each with the role the teacher assigned in the preview.
  invites: { email: string; role?: ClassroomRole }[]
  onProgress?: (progress: {
    processed: number
    total: number
    message: string
  }) => void
  // Injectable sleep for the Retry-After backoff (tests pass a no-op).
  sleepFn?: (ms: number) => Promise<void>
  // Max Retry-After-backed retry rounds for the deferred set.
  maxRetries?: number
}

export type BulkInviteByEmailResult = {
  // A fresh org email invite was created (carrying the role's team).
  invited: { email: string; role: ClassroomRole }[]
  // GitHub returned 422 — the email already belongs to a member or already has
  // a pending invite, so no new invite was sent. Unlike inviteRosterStudents'
  // skipped bucket ({ username; reason: "already-member" | "already-pending" }),
  // this deliberately carries no `reason`: a 422 on an EMAIL invite can't
  // disambiguate already-member from already-pending, so there's no honest
  // reason to report (the UI shows one static "already a member or invited"
  // detail). Widen to a reason literal only if that distinction ever surfaces.
  skipped: { email: string }[]
  // The invite call failed for a non-rate-limit reason.
  failed: { email: string; message: string }[]
  // Not attempted because a rate limit was hit mid-batch; retry later.
  deferred: string[]
}

// Bulk-invite a list of EMAIL addresses to the org, carrying the role's team so
// accepting the single invite activates the right membership: student ->
// classroom team, ta -> TA team, instructor -> the instructor team AND org
// OWNER (role "admin"). Writes NOTHING to roster.csv — an email carries no
// reliable GitHub identity until accepted; the invite surfaces as a `pending`
// row via the org pending-invitations list. Mirrors inviteRosterStudents'
// rate-limit handling (stop issuing new invites once throttled; defer the rest),
// and the same team resolution (resolveTeamIdByRole ensures the staff team for
// an instructor/ta invite, students-only never creates empty staff teams).
export async function bulkInviteByEmail(
  client: GitHubClient,
  input: BulkInviteByEmailInput,
): Promise<BulkInviteByEmailResult> {
  const {
    org,
    classroom,
    invites,
    onProgress,
    sleepFn = sleep,
    maxRetries = 3,
  } = input
  await assertClassroomNotArchived(client, org, classroom)

  const invited: BulkInviteByEmailResult["invited"] = []
  const skipped: BulkInviteByEmailResult["skipped"] = []
  const failed: BulkInviteByEmailResult["failed"] = []
  const deferred: string[] = []

  const targets = invites
    .map((i) => ({ email: i.email.trim(), role: i.role ?? "student" }))
    .filter((i) => i.email)
  if (targets.length === 0) return { invited, skipped, failed, deferred }

  const teamIdByRole = await resolveTeamIdByRole(
    client,
    org,
    classroom,
    new Set(targets.map((t) => t.role)),
  )

  // Block the whole batch if any role's team couldn't be resolved, mirroring the
  // single inviteByEmail guard: a team-less email invite is broken — the invitee
  // accepts into the org attached to no team and, since we write no roster.csv
  // row, is silently uncollected. Fail loudly BEFORE sending anything rather than
  // send a batch of orphaning invites. (The username bulk path can tolerate a
  // teamless invite because its CSV row still surfaces the person; an email
  // invite has no such fallback.)
  const rolesMissingTeam = [...new Set(targets.map((t) => t.role))].filter(
    (role) => teamIdByRole[role] === undefined,
  )
  if (rolesMissingTeam.length > 0) {
    throw new Error(
      `Couldn't resolve the classroom team for ${classroom}, so no invitations ` +
        `were sent. Make sure the classroom's GitHub team exists (re-run ` +
        `classroom setup if needed), then try again.`,
    )
  }

  let processed = 0
  const bump = (email: string) => {
    processed += 1
    onProgress?.({ processed, total: targets.length, message: email })
  }

  type EmailTarget = (typeof targets)[number]
  // Invite one email; throws on error so the caller classifies rate-limit/422.
  const inviteOne = (target: EmailTarget) => {
    const teamId = teamIdByRole[target.role]
    return createOrgInvitation(client, {
      org,
      email: target.email,
      team_ids: teamId ? [teamId] : undefined,
      role: githubOrgRoleForRole(target.role),
    })
  }

  let rateLimited = false
  let retryAfterMs = 0
  const deferredTargets: EmailTarget[] = []

  await mapWithConcurrency(targets, REPO_READ_CONCURRENCY, async (target) => {
    const { email } = target
    if (rateLimited) {
      deferredTargets.push(target)
      bump(email)
      return
    }
    try {
      await inviteOne(target)
      invited.push({ email, role: target.role })
    } catch (err) {
      if (err instanceof GitHubAPIError && err.isRateLimited) {
        rateLimited = true
        if (err.rateLimit.retryAfter !== null)
          retryAfterMs = Math.max(retryAfterMs, err.rateLimit.retryAfter * 1000)
        deferredTargets.push(target)
      } else if (err instanceof GitHubAPIError && err.status === 422) {
        // Already a member or already invited — nothing to send.
        skipped.push({ email })
      } else {
        failed.push({ email, message: getErrorMessage(err) })
      }
    } finally {
      bump(email)
    }
  })

  // Retry the deferred (rate-limited) set (see retryDeferred).
  const stillDeferred = await retryDeferred({
    queue: deferredTargets,
    maxRetries,
    sleepFn,
    initialRetryAfterMs: retryAfterMs,
    attempt: async (target) => {
      await inviteOne(target)
      invited.push({ email: target.email, role: target.role })
    },
    onError: (target, err) => {
      // A 422 on retry means already-member/already-invited, not a failure.
      if (err instanceof GitHubAPIError && err.status === 422)
        skipped.push({ email: target.email })
      else failed.push({ email: target.email, message: getErrorMessage(err) })
    },
  })
  for (const target of stillDeferred) deferred.push(target.email)

  return { invited, skipped, failed, deferred }
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

export type BulkEnrollStudentsResult = AddStudentsToClassroomResult & {
  teamResults: {
    username: string
    status: "added" | "failed"
    message?: string
  }[]
}

export type BulkImportResult = {
  addedStudents: StudentCsvRow[]
  skippedStudents: {
    username: string
    reason: "duplicate" | "not_found" | "invalid" | "error"
    message?: string
  }[]
  teamResults?: {
    username: string
    status: "added" | "failed"
    message?: string
  }[]
}
export async function bulkEnrollStudentsInClassroom(
  client: GitHubClient,
  input: AddStudentsToClassroomInput,
): Promise<BulkEnrollStudentsResult> {
  const { onProgress, ...bulkInput } = input

  await assertClassroomNotArchived(client, bulkInput.org, bulkInput.classroom)

  const total = (bulkInput.rows ?? bulkInput.usernames ?? []).length

  log.info("bulk enroll: started", {
    org: bulkInput.org,
    classroom: bulkInput.classroom,
    total,
  })

  onProgress?.({
    processed: 0,
    total,
    message: "Reading classroom roster...",
  })

  // Retry on conflict: a concurrent commit during the slow bulk window would
  // 409 and discard the whole import. Re-reading is safe — adds are append-only.
  const addResult = await addStudentsToClassroomWithConflictRetry(client, {
    ...bulkInput,
    onProgress,
  })

  // Roster commit already landed. A transient slug-read failure becomes a
  // per-student team failure rather than rejecting the whole bulk enroll.
  let teamSlug: string | undefined
  let teamSlugError: string | undefined
  try {
    teamSlug = await resolveClassroomTeamSlug(
      client,
      bulkInput.org,
      bulkInput.classroom,
    )
  } catch (err) {
    log.warn("bulk enroll: classroom team read failed, team adds will defer", {
      org: bulkInput.org,
      classroom: bulkInput.classroom,
      err,
    })
    teamSlugError = getErrorMessage(err)
  }

  const teamResults: BulkImportResult["teamResults"] = []

  for (let i = 0; i < addResult.addedStudents.length; i++) {
    const student = addResult.addedStudents[i]

    onProgress?.({
      processed: i,
      total: addResult.addedStudents.length,
      message: `Verifying ${student.username} in the organization...`,
    })

    // Verify by team membership through org membership: only an active org
    // member is team-added (the trust model used across the enroll paths). A
    // non-member is skipped here — they need an org invite first (sent by the
    // upload's invite pass), so there's nothing to team-add yet.
    if (!(await isActiveMember(client, bulkInput.org, student.username))) {
      onProgress?.({
        processed: i + 1,
        total: addResult.addedStudents.length,
        message: `Processed ${i + 1} of ${addResult.addedStudents.length}...`,
      })
      continue
    }

    if (teamSlug === undefined) {
      teamResults.push({
        username: student.username,
        status: "failed",
        message:
          `Could not read the classroom team to add the student` +
          (teamSlugError ? ` (${teamSlugError})` : "") +
          "; retry to add them to the team.",
      })

      onProgress?.({
        processed: i + 1,
        total: addResult.addedStudents.length,
        message: `Processed ${i + 1} of ${addResult.addedStudents.length} team memberships...`,
      })
      continue
    }

    const added = await tryAddUserToTeam(
      client,
      { org: bulkInput.org, teamSlug, username: student.username },
      "bulk enroll",
    )
    teamResults.push(
      added.ok
        ? { username: student.username, status: "added" }
        : {
            username: student.username,
            status: "failed",
            message: added.detail || "Could not add user to classroom team",
          },
    )

    onProgress?.({
      processed: i + 1,
      total: addResult.addedStudents.length,
      message: `Processed ${i + 1} of ${addResult.addedStudents.length} team memberships...`,
    })
  }

  onProgress?.({
    processed: total,
    total,
    message: "Import complete",
  })

  log.info("bulk enroll: completed", {
    org: bulkInput.org,
    classroom: bulkInput.classroom,
    added: addResult.addedStudents.length,
    skipped: addResult.skippedStudents.length,
    teamFailed: teamResults.filter((r) => r.status === "failed").length,
  })

  return {
    ...addResult,
    teamResults,
  }
}

// Does a roster.csv row identify the same person as `target`? The single
// authority for matching a removal target to a roster row, shared by
// unenrollStudent and bulkUnenrollStudents so the two can't drift.
//
// Identity is username/github_id only: every roster row now carries a GitHub
// identity, so email is never a match key (a shared email must not widen the
// match, and there are no username-less rows to target by email).
export function matchesRosterRow(row: StudentCsvRow, target: Student): boolean {
  const username = target.username?.trim()
  const githubId = target.github_id?.trim()
  return (
    (Boolean(username) &&
      row.username.toLowerCase() === username!.toLowerCase()) ||
    (Boolean(githubId) && Boolean(row.github_id) && row.github_id === githubId)
  )
}

export type UnenrollStudentInput = {
  org: string
  classroom: string
  student: Student
}
export async function unenrollStudent(
  client: GitHubClient,
  input: UnenrollStudentInput,
) {
  const { org, classroom, student: toRemoveStudent } = input
  log.info("unenroll student: started", { org, classroom })
  await assertClassroomNotArchived(client, org, classroom)
  const normalizedUsername = toRemoveStudent?.username.trim()
  const normalizedEmail = toRemoveStudent?.email?.trim()

  // An email-invited row not yet claimed has no username, so accept email too.
  // One of the two must be present to target a row.
  if (!normalizedUsername && !normalizedEmail) {
    throw new Error("Student's GitHub username or email is required")
  }

  // Resolve the slug concurrently with the commit. Can reject on a transient
  // read; attach a catch and consume it in the warning path below.
  const teamSlugPromise = resolveClassroomTeamSlug(client, org, classroom)
  teamSlugPromise.catch(() => {})

  // Read org state and viewer before the commit. State is null on read failure
  // (then we skip the org action). The viewer guards against removing the
  // signed-in teacher. An email-only row has no username to resolve state for.
  const orgStatePromise = normalizedUsername
    ? getOrgMembershipState(client, org, normalizedUsername)
    : Promise.resolve(null)
  orgStatePromise.catch(() => {})
  const viewerPromise = getAuthenticatedUser(client)
  viewerPromise.catch(() => {})

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

  const currentStudents = parseStudentsCsv(currentCsv.content)

  // Match the target row via the shared roster-row matcher (username/github_id).
  const sameRow = (student: StudentCsvRow) =>
    matchesRosterRow(student, toRemoveStudent)

  const exists = currentStudents.some(sameRow)

  if (!exists) {
    throw new Error(
      `Student ${toRemoveStudent.username || normalizedEmail} does not exist in roster!`,
    )
  }

  const nextStudents = currentStudents.filter((student) => !sameRow(student))
  const nextCsv = stringifyStudentsCsv(nextStudents)

  const tree = await createGitTree(client, {
    org,
    base_tree: commit.tree.sha,
    tree: rosterWriteTree(classroom, nextCsv, currentCsv.fromLegacy),
  })

  const newCommit = await createGitCommit(client, {
    org,
    message: prefixCommit(
      `Remove student: ${classroom}/${toRemoveStudent.username || normalizedEmail}`,
    ),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
  })

  const updatedRef = await updateRef(client, org, newCommit.sha, configBranch)

  // Commit landed, so every org-side step below is a non-fatal warning.
  const warnings: string[] = []

  // Drop from the classroom team. Idempotent (404 = not a member / team gone);
  // org membership untouched. Skipped for an email-only row.
  if (normalizedUsername) {
    try {
      const teamSlug = await teamSlugPromise
      await removeUserFromTeam(client, {
        org,
        teamSlug,
        username: normalizedUsername,
      })
    } catch (err) {
      log.error("team removal failed (student unenrolled)", { err })
      const detail = getErrorMessage(err)
      warnings.push(
        `${toRemoveStudent.username} was removed from the roster, but removing ` +
          `them from the classroom team failed (${detail}); they may keep read on ` +
          `private templates until it's retried.`,
      )
    }
  }

  // Cancel the pending invite only when it belongs solely to this classroom
  // (see resolveClassroomPendingInvite); a multi-classroom invite is left intact
  // so a sibling classroom's onboarding survives. An ACTIVE member is never
  // touched — unenroll is classroom-scoped; org removal lives on the Members
  // page. Resolve defensively: a reject after the commit landed would break the
  // "commit landed -> non-fatal warning" guarantee.
  const orgState = await orgStatePromise.catch(() => null)

  // Never cancel the signed-in teacher's own invite (a teacher mid-enrollment).
  const viewer = await viewerPromise.catch(() => null)
  const isSelf = isSameGitHubUser(viewer, toRemoveStudent)

  const shouldCancelInvite = orgState === "pending"

  if (shouldCancelInvite && isSelf) {
    warnings.push(
      `${toRemoveStudent.username} was removed from the roster. Their ` +
        `pending organization invite was kept because they are the signed-in ` +
        `account.`,
    )
  } else if (shouldCancelInvite) {
    const teamSlug = await teamSlugPromise.catch(() => undefined)
    warnings.push(
      ...(await cancelSoleClassroomInviteOnUnenroll(client, {
        org,
        classroom,
        username: normalizedUsername,
        displayName: toRemoveStudent.username,
        teamSlug,
        logContext: "org invite cancellation failed (student unenrolled)",
      })),
    )
  }

  log.info("unenroll student: completed", {
    org,
    classroom,
    warnings: warnings.length,
  })
  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha: tree.sha,
    newCommitSha: newCommit.sha,
    updatedRef,
    teamWarning: warnings.length > 0 ? warnings.join(" ") : undefined,
  }
}

export type BulkUnenrollProgress = {
  processed: number
  total: number
  message: string
}

export type BulkUnenrollStudentsInput = {
  org: string
  classroom: string
  students: Student[]
  onProgress?: (progress: BulkUnenrollProgress) => void
}

export type BulkUnenrollStudentsResult = {
  // Students whose roster row was dropped in the single CSV commit.
  removed: Student[]
  // Students whose row wasn't found in the CSV (already gone) — no-op, not an error.
  notFound: Student[]
  // Per-student non-fatal side-effect failures (team drop / invite cancel).
  warnings: string[]
  // The single roster commit's sha (undefined when nothing matched).
  newCommitSha?: string
}

// Remove MANY students from one classroom in a SINGLE roster commit, then run
// the per-student org-side side effects (team drop + pending-invite cancel)
// best-effort. The batch form of unenrollStudent: looping that per student
// would produce one commit PER student (N noisy commits racing the same ref),
// whereas real classes are unenrolled in bulk. Mirrors
// bulkEnrollStudentsInClassroom / addStudentsToClassroom (one commit for all).
//
// The CSV rewrite is conflict-retried and re-reads inside the closure, so a
// concurrent edit can't be clobbered. Org-side steps run only AFTER the commit
// lands, so — as in unenrollStudent — they are non-fatal warnings. Active
// members are never removed from the org here (unenroll is classroom-scoped);
// only a still-PENDING invite is cancelled, and never the signed-in teacher's.
export async function bulkUnenrollStudents(
  client: GitHubClient,
  input: BulkUnenrollStudentsInput,
): Promise<BulkUnenrollStudentsResult> {
  const { org, classroom, students, onProgress } = input
  await assertClassroomNotArchived(client, org, classroom)

  const targets = students.filter(
    (s) => s.username?.trim() || s.email?.trim() || s.github_id?.trim(),
  )
  if (targets.length === 0) {
    return { removed: [], notFound: [], warnings: [] }
  }

  log.info("bulk unenroll: started", { org, classroom, total: targets.length })

  // Same per-row match predicate as unenrollStudent (shared matchesRosterRow):
  // username/github_id.
  const matchesTarget = (row: StudentCsvRow, target: Student): boolean =>
    matchesRosterRow(row, target)

  // Resolve slug + viewer once, concurrently with the commit.
  const teamSlugPromise = resolveClassroomTeamSlug(client, org, classroom)
  teamSlugPromise.catch(() => {})
  const viewerPromise = getAuthenticatedUser(client)
  viewerPromise.catch(() => {})

  onProgress?.({
    processed: 0,
    total: targets.length,
    message: "Updating classroom roster...",
  })

  // One conflict-retried CSV commit dropping every matched row. Re-reads the CSV
  // each attempt so a concurrent edit is preserved. Reports which targets were
  // actually present (removed) vs. missing (notFound).
  const studentsFilePath = rosterPath(classroom)
  let removed: Student[] = []
  let notFound: Student[] = []
  let newCommitSha: string | undefined

  await withGitConflictRetry(async () => {
    const configBranch = await getConfigRepoBranch(client, org)
    const ref = await getBranchRef(client, org, configBranch)
    const commit = await getCommit(client, org, ref.object.sha)
    const currentCsv = await getRawFileWithFallbackSource(client, {
      org,
      path: studentsFilePath,
      fallbackPath: legacyRosterPath(classroom),
      ref: ref.object.sha,
    })
    const currentStudents = parseStudentsCsv(currentCsv.content)

    removed = targets.filter((target) =>
      currentStudents.some((row) => matchesTarget(row, target)),
    )
    notFound = targets.filter((target) => !removed.includes(target))

    if (removed.length === 0) {
      // Nothing to drop (all already gone) — skip the commit entirely.
      newCommitSha = undefined
      return
    }

    const nextStudents = currentStudents.filter(
      (row) => !removed.some((target) => matchesTarget(row, target)),
    )
    const nextCsv = stringifyStudentsCsv(nextStudents)

    const tree = await createGitTree(client, {
      org,
      base_tree: commit.tree.sha,
      tree: rosterWriteTree(classroom, nextCsv, currentCsv.fromLegacy),
    })
    const newCommit = await createGitCommit(client, {
      org,
      message: prefixCommit(
        `Remove ${removed.length} student${removed.length === 1 ? "" : "s"}: ${classroom}`,
      ),
      tree_sha: tree.sha,
      parents: [ref.object.sha],
    })
    await updateRef(client, org, newCommit.sha, configBranch)
    newCommitSha = newCommit.sha
  })

  // Roster commit landed; every org-side step below is a non-fatal warning.
  const warnings: string[] = []
  const viewer = await viewerPromise.catch(() => null)
  let teamSlug: string | undefined
  try {
    teamSlug = await teamSlugPromise
  } catch (err) {
    log.warn("bulk unenroll: classroom team read failed, skipping team drops", {
      org,
      classroom,
      err,
    })
    teamSlug = undefined
  }

  for (let i = 0; i < removed.length; i++) {
    const student = removed[i]
    const username = student.username?.trim()
    onProgress?.({
      processed: i,
      total: removed.length,
      message: `Updating team membership for ${username || student.email || "student"}...`,
    })

    // Drop from the classroom team (idempotent). Skipped for an email-only row
    // and when the slug couldn't be resolved.
    if (username && teamSlug) {
      try {
        await removeUserFromTeam(client, { org, teamSlug, username })
      } catch (err) {
        log.error("team removal failed (student bulk-unenrolled)", { err })
        warnings.push(
          `${username} was removed from the roster, but removing them from the ` +
            `classroom team failed (${getErrorMessage(err)}); they may keep read ` +
            `on private templates until it's retried.`,
        )
      }
    }

    // Cancel a still-pending invite only when it belongs solely to this
    // classroom (never an active member; never self). A multi-classroom invite
    // is left intact — the team drop above is the classroom-scoped effect.
    if (username) {
      const orgState = await getOrgMembershipState(client, org, username).catch(
        () => null,
      )
      if (orgState === "pending" && !isSameGitHubUser(viewer, student)) {
        warnings.push(
          ...(await cancelSoleClassroomInviteOnUnenroll(client, {
            org,
            classroom,
            username,
            teamSlug,
            logContext:
              "org invite cancellation failed (student bulk-unenrolled)",
          })),
        )
      } else if (orgState === "pending" && isSameGitHubUser(viewer, student)) {
        warnings.push(
          `${username} was removed from the roster. Their pending organization ` +
            `invite was kept because they are the signed-in account.`,
        )
      }
    }
  }

  onProgress?.({
    processed: removed.length,
    total: removed.length,
    message: "Done",
  })

  log.info("bulk unenroll: completed", {
    org,
    classroom,
    removed: removed.length,
    notFound: notFound.length,
    warnings: warnings.length,
  })

  return { removed, notFound, warnings, newCommitSha }
}

// The teacher-editable subset of a roster row. Identity columns (username,
// github_id) are deliberately excluded — they are bound at enrollment and by
// the team-driven roster, not hand-edited here.
export type StudentEditableFields = {
  first_name: string
  last_name: string
  email: string
  section: string
}

export type UpdateStudentInput = {
  org: string
  classroom: string
  // Stable identity of the target row (github_id, else username, else email),
  // captured BEFORE the edit. The edit never changes these keys, so the row is
  // still findable after the rewrite.
  key: string
  patch: StudentEditableFields
  // Identity columns for the row, used to CREATE it when no roster.csv row
  // matches `key` yet — a team member (e.g. a staff instructor/TA) added on
  // GitHub whose blank metadata row hasn't been written by syncRosterFromTeam.
  // Editing then upserts rather than failing. Omitted -> a missing key is an
  // error (the legacy strict behavior, for callers that guarantee the row).
  identity?: { github_id?: string; username?: string; email?: string }
}

export type UpdateStudentResult = CreateClassroomResult & {
  student: StudentCsvRow
}

// Edit one roster row's teacher-facing fields in place and commit the rewritten
// roster.csv. Identity columns are preserved verbatim from the matched row.
export async function updateStudent(
  client: GitHubClient,
  input: UpdateStudentInput,
): Promise<UpdateStudentResult> {
  const { org, classroom, key, patch, identity } = input

  const targetKey = key.trim()
  if (!targetKey) {
    throw new Error("A student row identity is required")
  }

  await assertClassroomNotArchived(client, org, classroom)

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

  const currentStudents = parseStudentsCsv(currentCsv.content)

  // Stable per-row identity via the shared studentKey (github_id -> username ->
  // email), the same precedence the UI and reconcile use.
  let targetIndex = currentStudents.findIndex(
    (row) => studentKey(row) === targetKey,
  )

  // Before treating a miss as an upsert, re-resolve by the FULL identity claim
  // (github_id OR case-insensitive username), not just the studentKey. A person
  // can have a legacy username-only (id-less) row while the edit is keyed by
  // github_id (buildTeamRoster stamps an enrolled row's id from the live GitHub
  // member): those keys differ, so a studentKey-only match would miss and append
  // a DUPLICATE. Matching the claim set edits the existing row instead — the
  // same id+login dedup syncRosterFromTeam uses.
  if (targetIndex === -1 && identity) {
    const idKey = identity.github_id?.trim()
    const loginKey = identity.username?.trim().toLowerCase()
    targetIndex = currentStudents.findIndex(
      (row) =>
        (Boolean(idKey) && row.github_id.trim() === idKey) ||
        (Boolean(loginKey) && row.username.trim().toLowerCase() === loginKey),
    )
  }

  // No matching row (even by claim): upsert when identity is provided (see the
  // `identity` field doc), else preserve the strict error.
  const missing = targetIndex === -1
  if (missing && !identity) {
    throw new Error(`Student does not exist in roster: ${targetKey}`)
  }

  const nextEmail = patch.email.trim()

  // Every roster row now carries a GitHub identity, so its email is metadata
  // and freely editable — the row is keyed by github_id/username, never email.

  // Guard against editing an email into one already held by ANOTHER row
  // (case-insensitive). On an upsert (missing, targetIndex -1) there is no self
  // row, so every match is a genuine clash.
  if (nextEmail) {
    const emailKey = nextEmail.toLowerCase()
    const clash = currentStudents.some(
      (row, idx) => idx !== targetIndex && row.email.toLowerCase() === emailKey,
    )
    if (clash) {
      throw new Error(`Email already used by another student: ${nextEmail}`)
    }
  }

  // Spread the existing row (preserving identity columns) or seed a new row from
  // the passed identity on an upsert, then overwrite only the editable fields.
  const updatedStudent = normalizeStudentRow({
    ...(missing ? (identity ?? {}) : currentStudents[targetIndex]),
    first_name: patch.first_name,
    last_name: patch.last_name,
    email: nextEmail,
    section: patch.section,
  })

  const nextStudents = missing
    ? [...currentStudents, updatedStudent]
    : currentStudents.map((row, idx) =>
        idx === targetIndex ? updatedStudent : row,
      )
  const nextCsv = stringifyStudentsCsv(nextStudents)

  const tree = await createGitTree(client, {
    org,
    base_tree: commit.tree.sha,
    tree: rosterWriteTree(classroom, nextCsv, currentCsv.fromLegacy),
  })

  const newCommit = await createGitCommit(client, {
    org,
    message: prefixCommit(
      `Edit student: ${classroom}/${updatedStudent.username || updatedStudent.email || targetKey}`,
    ),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
  })

  const updatedRef = await updateRef(client, org, newCommit.sha, configBranch)

  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha: tree.sha,
    newCommitSha: newCommit.sha,
    updatedRef,
    student: updatedStudent,
  }
}

export async function updateStudentWithConflictRetry(
  client: GitHubClient,
  input: UpdateStudentInput,
) {
  return withGitConflictRetry(() => updateStudent(client, input))
}
