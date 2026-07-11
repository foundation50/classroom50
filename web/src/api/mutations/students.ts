import Papa from "papaparse"
import type { GitHubClient } from "@/hooks/github/client"
import {
  addUserToTeam,
  createGitCommit,
  createGitTree,
  createOrgInvitation,
  ensureOrgMembership,
  getErrorMessage,
  getOrgMembershipState,
  isActiveMember,
  removeOrgMembership,
  removeUserFromTeam,
  staffTeamName,
  updateRef,
} from "@/hooks/github/mutations"
import {
  withGitConflictRetry,
  assertClassroomNotArchived,
  type CreateClassroomResult,
} from "./classrooms"
import {
  getRawFile,
  getRawFileWithFallback,
  getUser,
  listTeamMembers,
  sleep,
  REPO_READ_CONCURRENCY,
} from "@/hooks/github/queries"
import { getAuthenticatedUser } from "@/api/queries/users"
import { getBranchRef, getClassroomJson, getCommit } from "../github/queries"
import { GitHubAPIError, isDefinitiveGitHubStatus } from "@/hooks/github/errors"
import { isSameGitHubUser, parseGitHubId } from "@/util/students"
import { studentKey, rosterClaimSet } from "@/util/identity"
import { mapWithConcurrency } from "@/util/concurrency"
import { escapeCsvFormulaInjection } from "@/util/csv"
import { prefixCommit } from "@/util/commit"
import { rosterPath, legacyRosterPath } from "@/util/rosterPath"
import { ROLE_RANK, type RosterRole } from "@/util/teamRoster"
import { STAFF_ROLES, type StaffRole, type Student } from "@/types/classroom"
import { logger } from "@/lib/logger"

const log = logger.scope("mutations:students")

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
  return { slug: `classroom50-${classroom}` }
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

export const STUDENT_CSV_FIELDS = [
  "username",
  "first_name",
  "last_name",
  "email",
  "section",
  "github_id",
  "role",
] as const
type StudentCsvField = (typeof STUDENT_CSV_FIELDS)[number]

export type StudentCsvRow = Record<StudentCsvField, string>

export function normalizeStudentRow(
  row: Partial<Record<StudentCsvField, unknown>>,
): StudentCsvRow {
  return {
    username: String(row.username ?? "").trim(),
    first_name: String(row.first_name ?? "").trim(),
    last_name: String(row.last_name ?? "").trim(),
    email: String(row.email ?? "").trim(),
    section: String(row.section ?? "").trim(),
    github_id: String(row.github_id ?? "").trim(),
    // Best-effort recorded metadata (instructor/ta/student, or ""), refreshed
    // from the classroom's GitHub teams on sync. A pre-role file has no role
    // column, so this coerces to "".
    role: String(row.role ?? "").trim(),
  }
}

// Split a full name: first token is first_name, the remainder is last_name.
// Accepts null since GitHub's display name may be null. The single canonical
// implementation; re-exported from util/roster as splitName for UI callers.
export function splitName(name: string | null): {
  first_name: string
  last_name: string
} {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean)
  return { first_name: parts.at(0) ?? "", last_name: parts.slice(1).join(" ") }
}

export function parseStudentsCsv(csv: string): StudentCsvRow[] {
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    delimiter: ",",
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
  })

  // A `TooFewFields` row is tolerated ONLY when it is short by exactly one
  // column — the ambiguous-but-benign "trailing `github_id` omitted" case:
  // `octocat,Grace,Hopper,,Section A` (5 fields) maps cleanly under
  // `header: true` (the missing trailing field is `undefined`, coerced to "" by
  // normalizeStudentRow), so a sync/read shouldn't abort on a roster merely
  // missing trailing commas. A row short by TWO or more can't be explained by a
  // single dropped trailing field, and since Papa maps values POSITIONALLY it
  // would silently shift every value into the wrong column (corrupting the
  // identity/email join with no error) — exactly as untrustworthy as a
  // `TooManyFields` row, so it stays fatal. (A row short by exactly one where a
  // MIDDLE cell was dropped is positionally indistinguishable from a dropped
  // trailing field, so it is unavoidably read as the latter; nothing in the row
  // data can disambiguate the two.)
  // Only re-parse (tooFewFieldsAreTrailingOnly runs a second full parse) when a
  // TooFewFields error is actually present — the flag is never read otherwise.
  const shortRowsWithinTolerance =
    parsed.errors.some((error) => error.code === "TooFewFields") &&
    tooFewFieldsAreTrailingOnly(
      csv,
      parsed.meta.fields?.length ?? STUDENT_CSV_FIELDS.length,
    )

  const fatalErrors = parsed.errors.filter(
    (error) =>
      error.type !== "Delimiter" &&
      !(error.code === "TooFewFields" && shortRowsWithinTolerance),
  )

  if (fatalErrors.length > 0) {
    throw new Error(
      `Could not parse roster.csv: ${fatalErrors
        .map((error) => error.message)
        .join("; ")}`,
    )
  }

  return parsed.data
    .map((row) => normalizeStudentRow(row))
    .filter((row) => row.username || row.github_id || row.email)
}

// True when EVERY short data row is short by exactly one column, i.e. only the
// trailing field was dropped. Re-parses without `header` to read raw row widths
// (the header-keyed `data` hides which physical column is missing), so a row
// dropping a middle cell — which Papa would silently left-shift — is NOT treated
// as benign. A row that's short by 2+ (or a header we couldn't count) is fatal.
function tooFewFieldsAreTrailingOnly(
  csv: string,
  headerWidth: number,
): boolean {
  if (headerWidth <= 0) return false
  const raw = Papa.parse<string[]>(csv, {
    delimiter: ",",
    skipEmptyLines: "greedy",
  })
  // rows[0] is the header; a short DATA row is benign only at width-1.
  return raw.data
    .slice(1)
    .every(
      (row) => row.length === headerWidth || row.length === headerWidth - 1,
    )
}

// Which student fields to defang. Applied to name/section free text AND email —
// email is a member-controlled GitHub profile field written verbatim by
// syncRosterFromTeam/bulk import, so a formula-leading verified email (e.g.
// `=1+1@evil.com`) would otherwise reach roster.csv and execute on open. NOT
// applied to github_id/tokens/hashes/timestamps, which must round-trip
// byte-exact.
//
// NOTE: this writes the leading quote into the STORED value, so any consumer of
// roster.csv (this app's parse layer, the gh-teacher CLI) must tolerate it on
// these fields. The Go writer defangs the same set; keep them in lockstep.
// Email matching keys on the normalized (trim+lowercase) email, so guarding the
// cell doesn't affect match-by-email.
const FORMULA_GUARDED_FIELDS = [
  "first_name",
  "last_name",
  "section",
  "email",
] as const

function stringifyStudentsCsv(rows: StudentCsvRow[]) {
  const normalizedRows = rows
    .map((row) => normalizeStudentRow(row))
    .filter((row) => row.username || row.github_id || row.email)
    .map((row) => {
      const guarded = { ...row }
      for (const field of FORMULA_GUARDED_FIELDS) {
        guarded[field] = escapeCsvFormulaInjection(guarded[field])
      }
      return guarded
    })

  // Papa.unparse omits the header for an empty array, so an emptied roster
  // would commit a header-less file the CLI/skeleton readers reject. Write the
  // canonical header explicitly instead (keep in lockstep with STUDENT_CSV_FIELDS).
  if (normalizedRows.length === 0) {
    return STUDENT_CSV_FIELDS.join(",") + "\n"
  }

  return (
    Papa.unparse(normalizedRows, {
      columns: [...STUDENT_CSV_FIELDS],
      delimiter: ",",
      header: true,
      newline: "\n",
    }) + "\n"
  )
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

  const ref = await getBranchRef(client, input.org)
  const commit = await getCommit(client, input.org, ref.object.sha)

  const studentsFilePath = rosterPath(input.classroom)

  const currentCsv = await getRawFileWithFallback(client, {
    org: input.org,
    path: studentsFilePath,
    fallbackPath: legacyRosterPath(input.classroom),
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
    tree: [
      {
        path: studentsFilePath,
        mode: "100644",
        type: "blob",
        content: nextCsv,
      },
    ],
  })

  const newCommit = await createGitCommit(client, {
    org: input.org,
    message: prefixCommit(
      `Add student: ${input.classroom}/${student.username}`,
    ),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
  })

  const updatedRef = await updateRef(client, input.org, newCommit.sha)

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
  // Write the new row directly as `enrolled` (vs `invited`); set when the
  // student is already an active org member, so they aren't stranded.
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

  // Already an active member -> write the row enrolled directly (no invite is
  // sent, so reconcile would never confirm them). Best-effort: a failed read
  // falls back to the normal "invited" path.
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

  const ref = await getBranchRef(client, input.org)
  const commit = await getCommit(client, input.org, ref.object.sha)

  const studentsFilePath = rosterPath(input.classroom)

  const currentCsv = await getRawFileWithFallback(client, {
    org: input.org,
    path: studentsFilePath,
    fallbackPath: legacyRosterPath(input.classroom),
    ref: ref.object.sha,
  })

  const currentStudents = parseStudentsCsv(currentCsv)

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
    throw new Error("No new students to add")
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
    tree: [
      {
        path: studentsFilePath,
        mode: "100644",
        type: "blob",
        content: nextCsv,
      },
    ],
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

  const updatedRef = await updateRef(client, input.org, newCommit.sha)

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
  role: RosterRole
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
    student: json?.team?.slug || `classroom50-${classroom}`,
    staff: {
      instructor:
        json?.teams?.instructor?.slug || staffTeamName(classroom, "instructor"),
      ta: json?.teams?.ta?.slug || staffTeamName(classroom, "ta"),
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
): Promise<MemberWithRole[]> {
  // The student read stays strict (a transient failure there fails the sync so
  // it retries against fresh state). The two staff reads are best-effort: a
  // flaky or permission-blocked staff team degrades to [] rather than blocking
  // an otherwise-fine student sync — listTeamMembers already treats a missing
  // team (404) as [], so only a non-404 reject reaches the settle here.
  const [studentMembers, ...staffMemberLists] = await Promise.all([
    listTeamMembers(client, org, slugs.student),
    ...STAFF_ROLES.map((role) =>
      Promise.allSettled([
        listTeamMembers(client, org, slugs.staff[role]),
      ]).then(([r]) => (r.status === "fulfilled" ? r.value : [])),
    ),
  ])

  const byId = new Map<number, MemberWithRole>()
  const consider = (
    member: { id: number; login: string; email?: string | null },
    role: RosterRole,
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

  return [...byId.values()]
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
    const [members, ref] = await Promise.all([
      listClassroomMembersWithRoles(client, org, slugs),
      getBranchRef(client, org),
    ])
    const commit = await getCommit(client, org, ref.object.sha)

    const studentsFilePath = rosterPath(classroom)
    const currentCsv = await getRawFileWithFallback(client, {
      org,
      path: studentsFilePath,
      fallbackPath: legacyRosterPath(classroom),
      ref: ref.object.sha,
    })
    const currentStudents = parseStudentsCsv(currentCsv)

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

    // Refresh the recorded role on existing rows whose team-derived role has
    // changed (a promotion/demotion, or a first-ever role on a pre-role row).
    // Matched by id, then login — the same identity join used above. This is
    // the only in-place edit sync makes; name/email/section stay teacher-owned.
    const roleById = new Map(members.map((m) => [String(m.id), m.role]))
    const roleByLogin = new Map(
      members.map((m) => [m.login.toLowerCase(), m.role]),
    )
    let roleChanges = 0
    const reconciledStudents = currentStudents.map((s) => {
      const role =
        (s.github_id ? roleById.get(s.github_id.trim()) : undefined) ??
        roleByLogin.get(s.username.trim().toLowerCase())
      if (role && role !== s.role) {
        roleChanges++
        return { ...s, role }
      }
      return s
    })

    if (missing.length === 0 && roleChanges === 0) {
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
      tree: [
        {
          path: studentsFilePath,
          mode: "100644",
          type: "blob",
          content: nextCsv,
        },
      ],
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

    await updateRef(client, org, newCommit.sha)

    log.info("sync roster from team: completed", {
      org,
      classroom,
      added: addedRows.length,
      roleChanges,
    })
    return {
      addedUsernames: addedRows.map((r) => r.username),
      noop: false,
    }
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
  try {
    return await getRawFile(client, { org, path, ref })
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 404) return null
    throw err
  }
}

// Converge a classroom bootstrapped before the students.csv -> roster.csv
// rename onto roster.csv, so the file always physically exists. Mirrors the CLI
// `gh teacher roster migrate`: if only the legacy students.csv is present, write
// roster.csv with its bytes verbatim and delete students.csv in ONE tree commit.
// Idempotent: a no-op when roster.csv already exists, and nothing-to-do when
// neither file is present (a brand-new classroom's roster.csv is created by the
// team sync instead). Runs inside the conflict-retry loop so a concurrent write
// (e.g. an interleaved roster edit) is re-read rather than clobbered.
export async function migrateRosterFile(
  client: GitHubClient,
  input: { org: string; classroom: string },
): Promise<MigrateRosterFileResult> {
  const { org, classroom } = input
  const rosterFilePath = rosterPath(classroom)
  const legacyPath = legacyRosterPath(classroom)

  return withGitConflictRetry(async () => {
    const ref = await getBranchRef(client, org)
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
    // delete students.csv in a single commit (mode 100644; sha:null deletes).
    const tree = await createGitTree(client, {
      org,
      base_tree: commit.tree.sha,
      tree: [
        {
          path: rosterFilePath,
          mode: "100644",
          type: "blob",
          content: legacyBytes,
        },
        { path: legacyPath, mode: "100644", type: "blob", sha: null },
      ],
    })

    const newCommit = await createGitCommit(client, {
      org,
      message: prefixCommit(`Migrate students.csv to roster.csv: ${classroom}`),
      tree_sha: tree.sha,
      parents: [ref.object.sha],
    })

    await updateRef(client, org, newCommit.sha)

    log.info("migrate roster file: renamed students.csv -> roster.csv", {
      org,
      classroom,
    })
    return { migrated: true }
  })
}

export type ReconcileTeamInput = {
  org: string
  classroom: string
  // The rostered usernames (from `not_in_org` rows) to try to promote onto the
  // classroom team. These are the GitHub usernames the teacher put in
  // roster.csv — the teacher owns their accuracy; this is just a convenient
  // batch team-add. A username that isn't an active org member is skipped and
  // stays `not_in_org` (highlighted in the roster for invite/removal).
  usernames: string[]
}

export type ReconcileTeamResult = {
  // Usernames added to the classroom team this run.
  added: string[]
  // Rostered usernames that aren't active org members yet, so nothing was added
  // — they stay `not_in_org` for the teacher to invite or remove. Not an error.
  skipped: string[]
  // Usernames whose team-add API call failed (retryable, worth surfacing).
  failed: { login: string; message: string }[]
}

// Batch-add the roster's `not_in_org` students to the classroom team when they
// turn out to already be active org members — the convenient team-add the
// teacher would otherwise do by hand. The CSV username is authoritative (the
// teacher owns its accuracy); this only closes the gap where a student joined
// the ORG (native invite / SSO) but was never put on the team. Each add is:
//   1) verified as an ACTIVE org member (never team-add a non-member); a
//      non-member is SKIPPED (stays `not_in_org`, highlighted), not a failure.
//   2) an idempotent PUT team membership.
// Best-effort per user: one failure never blocks the others, and nothing here
// touches org membership or roster.csv.
export async function reconcileTeamFromOrgMembers(
  client: GitHubClient,
  input: ReconcileTeamInput,
): Promise<ReconcileTeamResult> {
  const { org, classroom, usernames } = input
  log.info("reconcile team from org members: started", {
    org,
    classroom,
    candidates: usernames.length,
  })
  await assertClassroomNotArchived(client, org, classroom)

  const added: string[] = []
  const skipped: string[] = []
  const failed: ReconcileTeamResult["failed"] = []

  if (usernames.length === 0) return { added, skipped, failed }

  const teamSlug = await resolveClassroomTeamSlug(client, org, classroom)

  // Check active org membership for all candidates concurrently (bounded) — each
  // is an independent GET, and on a roster open with N drifted rows a serial
  // scan is up to N blocking round-trips. A throw still rejects the whole run
  // (Promise.all semantics), matching the prior serial loop.
  const logins = usernames.map((u) => u.trim()).filter(Boolean)
  const memberships = await mapWithConcurrency(
    logins,
    REPO_READ_CONCURRENCY,
    async (login) => ({
      login,
      active: await isActiveMember(client, org, login),
    }),
  )

  // Only team-add active org members. A rostered non-member isn't a failure —
  // they simply aren't in the org yet, so they stay `not_in_org` and the roster
  // highlights them for the teacher to invite or remove.
  for (const { login, active } of memberships) {
    if (!active) {
      skipped.push(login)
      continue
    }
    const result = await tryAddUserToTeam(
      client,
      { org, teamSlug, username: login },
      "reconcile team from org members",
    )
    if (result.ok) added.push(login)
    else failed.push({ login, message: result.detail })
  }

  log.info("reconcile team from org members: completed", {
    org,
    classroom,
    added: added.length,
    skipped: skipped.length,
    failed: failed.length,
  })
  return { added, skipped, failed }
}

export type InviteRosterStudentsInput = {
  org: string
  classroom: string
  // Rows to invite. Each carries at least a username (a `not_in_org` roster row
  // always has one); github_id is used when present, else derived from the
  // username. `pending` rows are handled by resendOrgInvitation, not here.
  students: { username: string; github_id?: string }[]
  onProgress?: (progress: {
    processed: number
    total: number
    message: string
  }) => void
}

export type InviteRosterStudentsResult = {
  // A fresh org invite was created (carrying the classroom team).
  invited: string[]
  // Already an active member or already had a pending invite — no new invite.
  skipped: { username: string; reason: "already-member" | "already-pending" }[]
  // Couldn't invite (username didn't resolve to a GitHub account, or the invite
  // call failed).
  failed: { username: string; message: string }[]
  // Not attempted because a GitHub rate limit was hit mid-batch — the teacher
  // can retry these later once the limit clears (see the short-circuit below).
  deferred: string[]
}

// Bulk-invite roster students who are on roster.csv (by username) but not yet
// in the organization — the `not_in_org` rows. Resolves each username to its
// immutable GitHub id (using the stored github_id when present, else
// GET /users/{username}) and sends a fresh org invitation carrying the
// classroom team, so accepting it activates team membership atomically. This is
// the roster-side counterpart to the Org Members "Invite" action; it does NOT
// write roster.csv (identity backfill is syncRosterFromTeam's job) and never
// touches an existing active/pending state (ensureOrgMembership no-ops those).
export async function inviteRosterStudents(
  client: GitHubClient,
  input: InviteRosterStudentsInput,
): Promise<InviteRosterStudentsResult> {
  const { org, classroom, students, onProgress } = input
  await assertClassroomNotArchived(client, org, classroom)

  const invited: string[] = []
  const skipped: InviteRosterStudentsResult["skipped"] = []
  const failed: InviteRosterStudentsResult["failed"] = []
  const deferred: string[] = []

  const targets = students
    .map((s) => ({ username: s.username.trim(), github_id: s.github_id }))
    .filter((s) => s.username)
  if (targets.length === 0) return { invited, skipped, failed, deferred }

  // Resolve the classroom team once so every fresh invite carries it (accepting
  // the single org invite then activates team membership). A missing team id is
  // tolerated — the invite still sends, just without the team attached.
  let teamIds: number[] | undefined
  try {
    const teamId = (await resolveClassroomTeam(client, org, classroom)).id
    teamIds = teamId ? [teamId] : undefined
  } catch {
    teamIds = undefined
  }

  let processed = 0
  const bump = (username: string) => {
    processed += 1
    onProgress?.({ processed, total: targets.length, message: username })
  }

  // Once GitHub returns a (secondary) rate limit, stop issuing new invites:
  // hammering a throttled endpoint for every remaining target only extends the
  // throttle window and floods the results with spurious failures. Remaining
  // targets are reported as `deferred` for a later retry — mirroring the
  // pending-resend loop in RosterBulkActionsBar, which breaks on isRateLimited.
  let rateLimited = false

  await mapWithConcurrency(targets, REPO_READ_CONCURRENCY, async (target) => {
    const { username } = target
    if (rateLimited) {
      deferred.push(username)
      bump(username)
      return
    }
    try {
      // Prefer the stored id; otherwise resolve the current account by login.
      const inviteeId =
        parseGitHubId(target.github_id ?? "") ??
        (await getUser(client, username)).id
      const result = await ensureOrgMembership(client, {
        org,
        username,
        inviteeId,
        teamIds,
      })
      if (result.state === "invited") invited.push(username)
      else if (result.state === "active")
        skipped.push({ username, reason: "already-member" })
      else skipped.push({ username, reason: "already-pending" })
    } catch (err) {
      if (err instanceof GitHubAPIError && err.isRateLimited) {
        rateLimited = true
        deferred.push(username)
      } else {
        failed.push({ username, message: getErrorMessage(err) })
      }
    } finally {
      bump(username)
    }
  })

  return { invited, skipped, failed, deferred }
}

export type BulkEnrollStudentsResult = AddStudentsToClassroomResult & {
  teamResults: {
    username: string
    status: "added" | "failed"
    message?: string
  }[]
  // Added to roster.csv but NOT an active org member and not a pending invite
  // — on the roster, not in the organization. Surfaced so the teacher can chase
  // an invite; the team-driven roster shows them as `not_in_org`.
  notInOrg: string[]
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
  notInOrg?: string[]
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
  const notInOrg: string[] = []

  for (let i = 0; i < addResult.addedStudents.length; i++) {
    const student = addResult.addedStudents[i]

    onProgress?.({
      processed: i,
      total: addResult.addedStudents.length,
      message: `Verifying ${student.username} in the organization...`,
    })

    // Verify by team membership through org membership: only an active org
    // member is team-added (the trust model used across the enroll paths). A
    // non-member is recorded as not_in_org (needs an invite) rather than a team
    // failure — they aren't in the org to add yet.
    if (!(await isActiveMember(client, bulkInput.org, student.username))) {
      notInOrg.push(student.username)
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
    notInOrg: notInOrg.length,
    teamFailed: teamResults.filter((r) => r.status === "failed").length,
  })

  return {
    ...addResult,
    teamResults,
    notInOrg,
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

  const ref = await getBranchRef(client, org)
  const commit = await getCommit(client, org, ref.object.sha)

  const studentsFilePath = rosterPath(classroom)

  const currentCsv = await getRawFileWithFallback(client, {
    org,
    path: studentsFilePath,
    fallbackPath: legacyRosterPath(classroom),
    ref: ref.object.sha,
  })

  const currentStudents = parseStudentsCsv(currentCsv)

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
    tree: [
      {
        path: studentsFilePath,
        mode: "100644",
        type: "blob",
        content: nextCsv,
      },
    ],
  })

  const newCommit = await createGitCommit(client, {
    org,
    message: prefixCommit(
      `Remove student: ${classroom}/${toRemoveStudent.username || normalizedEmail}`,
    ),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
  })

  const updatedRef = await updateRef(client, org, newCommit.sha)

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

  // Cancel a pending invite (a not-yet-accepted invitee has no cross-classroom
  // footprint). An ACTIVE member is never removed here — unenroll is
  // classroom-scoped; org removal lives on the Members page. Resolve
  // defensively: a reject after the roster commit landed would discard
  // accumulated warnings and break the "commit landed -> non-fatal" guarantee.
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
    try {
      await removeOrgMembership(client, { org, username: normalizedUsername })
    } catch (err) {
      log.error("org invite cancellation failed (student unenrolled)", { err })
      const detail = getErrorMessage(err)
      warnings.push(
        `${toRemoveStudent.username} was removed from the roster, but ` +
          `cancelling their pending org invite failed (${detail}); retry from ` +
          `the organization's people page.`,
      )
    }
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
    const ref = await getBranchRef(client, org)
    const commit = await getCommit(client, org, ref.object.sha)
    const currentCsv = await getRawFileWithFallback(client, {
      org,
      path: studentsFilePath,
      fallbackPath: legacyRosterPath(classroom),
      ref: ref.object.sha,
    })
    const currentStudents = parseStudentsCsv(currentCsv)

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
      tree: [
        {
          path: studentsFilePath,
          mode: "100644",
          type: "blob",
          content: nextCsv,
        },
      ],
    })
    const newCommit = await createGitCommit(client, {
      org,
      message: prefixCommit(
        `Remove ${removed.length} student${removed.length === 1 ? "" : "s"}: ${classroom}`,
      ),
      tree_sha: tree.sha,
      parents: [ref.object.sha],
    })
    await updateRef(client, org, newCommit.sha)
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

    // Cancel a still-pending invite only (never an active member; never self).
    if (username) {
      const orgState = await getOrgMembershipState(client, org, username).catch(
        () => null,
      )
      if (orgState === "pending" && !isSameGitHubUser(viewer, student)) {
        try {
          await removeOrgMembership(client, { org, username })
        } catch (err) {
          log.error(
            "org invite cancellation failed (student bulk-unenrolled)",
            {
              err,
            },
          )
          warnings.push(
            `${username} was removed from the roster, but cancelling their ` +
              `pending org invite failed (${getErrorMessage(err)}); retry from ` +
              `the organization's people page.`,
          )
        }
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
  const { org, classroom, key, patch } = input

  const targetKey = key.trim()
  if (!targetKey) {
    throw new Error("A student row identity is required")
  }

  await assertClassroomNotArchived(client, org, classroom)

  const ref = await getBranchRef(client, org)
  const commit = await getCommit(client, org, ref.object.sha)

  const studentsFilePath = rosterPath(classroom)

  const currentCsv = await getRawFileWithFallback(client, {
    org,
    path: studentsFilePath,
    fallbackPath: legacyRosterPath(classroom),
    ref: ref.object.sha,
  })

  const currentStudents = parseStudentsCsv(currentCsv)

  // Stable per-row identity via the shared studentKey (github_id -> username ->
  // email), the same precedence the UI and reconcile use.
  const targetIndex = currentStudents.findIndex(
    (row) => studentKey(row) === targetKey,
  )

  if (targetIndex === -1) {
    throw new Error(`Student does not exist in roster: ${targetKey}`)
  }

  const existing = currentStudents[targetIndex]

  const nextEmail = patch.email.trim()

  // Every roster row now carries a GitHub identity, so its email is metadata
  // and freely editable — the row is keyed by github_id/username, never email.

  // Guard against editing an email into one already held by ANOTHER row
  // (case-insensitive). The target row matching its own current email is fine.
  if (nextEmail) {
    const emailKey = nextEmail.toLowerCase()
    const clash = currentStudents.some(
      (row, idx) => idx !== targetIndex && row.email.toLowerCase() === emailKey,
    )
    if (clash) {
      throw new Error(`Email already used by another student: ${nextEmail}`)
    }
  }

  // Spread the existing row so identity columns are preserved, then overwrite
  // only the four editable fields.
  const updatedStudent = normalizeStudentRow({
    ...existing,
    first_name: patch.first_name,
    last_name: patch.last_name,
    email: nextEmail,
    section: patch.section,
  })

  const nextStudents = currentStudents.map((row, idx) =>
    idx === targetIndex ? updatedStudent : row,
  )
  const nextCsv = stringifyStudentsCsv(nextStudents)

  const tree = await createGitTree(client, {
    org,
    base_tree: commit.tree.sha,
    tree: [
      {
        path: studentsFilePath,
        mode: "100644",
        type: "blob",
        content: nextCsv,
      },
    ],
  })

  const newCommit = await createGitCommit(client, {
    org,
    message: prefixCommit(
      `Edit student: ${classroom}/${updatedStudent.username || updatedStudent.email || targetKey}`,
    ),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
  })

  const updatedRef = await updateRef(client, org, newCommit.sha)

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
