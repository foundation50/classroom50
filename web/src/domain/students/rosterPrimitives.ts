import type { GitHubClient } from "@/github-core/client"
import {
  addUserToTeam,
  cancelOrgInvitation,
  ensureClassroomRoleTeam,
  grantTeamConfigRepoWrite,
  type GitTreeEntry,
} from "@/github-core/mutations"
import { getErrorMessage } from "@/github-core/errorMessage"
import {
  getRawFile,
  listTeamInvitations,
  listTeamMembers,
  sleep,
} from "@/github-core/queries"
import { getClassroomJson } from "@/github-core/configRepoReads"
import {
  GitHubAPIError,
  isDefinitiveGitHubStatus,
  tolerateGitHubError,
} from "@/github-core/errors"
import { rosterPath, legacyRosterPath } from "@/util/rosterPath"
import { ROLE_RANK, type ClassroomRole } from "@/util/teamRoster"
import { classroomTeamSlug } from "@/util/teamSlug"
import { STAFF_ROLES, type StaffRole, type Student } from "@/types/classroom"
import type { StudentCsvRow } from "@/util/rosterCsv"
import { logger } from "@/lib/logger"

export const log = logger.scope("mutations:students")

// Git-tree entries for a roster write: the roster.csv blob, plus — when
// `fromLegacy` (from getRawFileWithFallbackSource) — a delete of the legacy
// path, so a first edit of an un-migrated classroom converges it in one commit
// (matching `gh teacher roster migrate`) instead of leaving a stale copy.
export function rosterWriteTree(
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
export async function resolveClassroomTeamSlug(
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
export async function cancelSoleClassroomInviteOnUnenroll(
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
export async function resolveClassroomTeam(
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
export async function resolveClassroomTeamWithRetry(
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
export async function tryAddUserToTeam(
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

// A single classroom member unioned across the student + staff teams, tagged
// with their highest-precedence role (instructor > ta > student).
export type MemberWithRole = {
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
export async function resolveClassroomTeamSlugs(
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
export async function listClassroomMembersWithRoles(
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

// Read a config file's bytes, or null on a true 404. A non-404 propagates so a
// transient API failure is never mistaken for "file absent".
export async function readFileOrNull(
  client: GitHubClient,
  org: string,
  path: string,
  ref: string,
): Promise<string | null> {
  return tolerateGitHubError(() => getRawFile(client, { org, path, ref }), null)
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
export async function retryDeferred<T>(opts: {
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

// Resolve the team id for each role present in the invite batch: student ->
// classroom team, instructor/ta -> the staff team (created if missing, mirroring
// the Settings staff flow so an instructor/ta invite lands them on the right
// team on acceptance). Only ensures a staff team when that role is actually
// being invited — a students-only upload must not create (and grant config-repo
// write to) empty instructor/ta teams as a side effect. A failed resolve leaves
// that role's id undefined — the invite still sends teamless.
export async function resolveTeamIdByRole(
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
