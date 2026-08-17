import type { GitHubClient } from "@/github-core/client"
import {
  createOrgInvitation,
  deleteInviteTeam,
  ensureInviteTeam,
  ensureOrgMembership,
} from "@/github-core/mutations"
import { getErrorMessage } from "@/github-core/errorMessage"
import { assertClassroomNotArchived } from "../classrooms"
import { getAuthenticatedUser } from "../queries/users"
import { getUser, sleep, REPO_READ_CONCURRENCY } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { resolveGitHubId } from "@/util/students"
import { mapWithConcurrency } from "@/util/concurrency"
import { githubOrgRoleForRole, type ClassroomRole } from "@/util/teamRoster"
import {
  retryDeferred,
  resolveTeamIdByRole,
  appendEmailInviteRows,
  log,
} from "./rosterPrimitives"
import i18n from "@/i18n"

export type InviteRosterStudentsInput = {
  org: string
  classroom: string
  // Rows to invite. Each carries at least a username (a roster.csv row always
  // has one); github_id is used when present, else derived from the username.
  // `role` (default "student") selects the target team and org role: student ->
  // classroom team, ta -> TA team, teacher -> org OWNER (admin) + teacher
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
// atomically: student -> classroom team, ta -> TA team, teacher -> the
// teacher team AND org OWNER (role "admin"). Does NOT write roster.csv
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
    // A present cell resolves to its account even when spelled non-canonically;
    // only a BLANK one may fall back to the mutable login. Falling back for an
    // unusable cell would send the org invite (and its team, hence repo access)
    // to whoever holds that login today, which is what github_id exists to
    // prevent — the same reasoning as runRosterImport's id threading.
    const raw = (target.github_id ?? "").trim()
    const resolvedId = resolveGitHubId(raw)
    if (raw !== "" && resolvedId === null) {
      throw new Error(
        i18n.t("students.inviteRosterMalformedId", {
          username,
          githubId: raw,
        }),
      )
    }
    const inviteeId = resolvedId ?? (await getUser(client, username)).id
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

export type BulkInviteByEmailInput = {
  org: string
  classroom: string
  // Emails to invite, each with the role the teacher assigned in the preview.
  // The optional name/section ride along onto the pending roster row so a CSV
  // import doesn't lose the metadata it supplied (the row is written before the
  // student has an account, so nothing else can fill it in).
  invites: {
    email: string
    role?: ClassroomRole
    first_name?: string
    last_name?: string
    section?: string
  }[]
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
// classroom team, ta -> TA team, teacher -> the teacher team AND org
// OWNER (role "admin"). Every successfully sent invite carries a per-invite
// metadata team and is retained on the roster as an email-only PENDING row, all
// in ONE commit for the batch (see appendEmailInviteRows); each row lives exactly
// as long as its invite team does. A target whose metadata team can't be
// prepared is reported as FAILED rather than invited without email retention.
// The invite also surfaces as a `pending` row via the org pending-invitations
// list. Mirrors inviteRosterStudents' rate-limit handling (stop issuing new
// invites once throttled; defer the rest), and the same team resolution
// (resolveTeamIdByRole ensures the staff team for a teacher/ta invite,
// students-only never creates empty staff teams).
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
    .map((i) => ({
      email: i.email.trim(),
      role: i.role ?? "student",
      first_name: i.first_name,
      last_name: i.last_name,
      section: i.section,
    }))
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

  // Resolved once for the whole batch: every invite team must be cleared of the
  // acting teacher, and the identity is the same for all of them.
  const actor = await getAuthenticatedUser(client)

  let processed = 0
  const bump = (email: string) => {
    processed += 1
    onProgress?.({ processed, total: targets.length, message: email })
  }

  type EmailTarget = (typeof targets)[number]
  // Invite one email; throws on error so the caller classifies rate-limit/422.
  // The metadata team is a precondition, not a nicety: it's the only thing that
  // retains the invited address, so a failure to prepare it throws and the
  // target lands in `failed` rather than sending an invite whose email is
  // silently dropped. Nothing has been sent at that point, so a retry is clean.
  const inviteOne = async (target: EmailTarget): Promise<void> => {
    const teamId = teamIdByRole[target.role]
    const teamIds = teamId ? [teamId] : []
    const inviteTeam = await ensureInviteTeam(
      client,
      org,
      { email: target.email, classroom },
      actor.login,
    )
    teamIds.push(inviteTeam.id)
    try {
      await createOrgInvitation(client, {
        org,
        email: target.email,
        team_ids: teamIds.length > 0 ? teamIds : undefined,
        role: githubOrgRoleForRole(target.role),
      })
    } catch (err) {
      // A doomed invite (422 already-member/-invited, or a hard failure) must
      // not leave a fresh, member-less metadata team behind for GC to reap.
      // Keep it on a rate limit (the deferred retry re-adopts it) and keep an
      // adopted team (it may hold a prior invite's still-unrecovered record).
      const rateLimited = err instanceof GitHubAPIError && err.isRateLimited
      if (!rateLimited && inviteTeam.created) {
        try {
          await deleteInviteTeam(client, org, inviteTeam.slug)
        } catch (cleanupErr) {
          log.error("bulk invite metadata team cleanup failed", {
            email: target.email,
            err: cleanupErr,
          })
        }
      }
      throw err
    }
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

  // Retain the invited emails on the roster, one commit for the whole batch
  // (best-effort; a miss is appended by the acceptance reconcile). Every
  // successful invite carries its invite team, so `invited` is the row set. The
  // name/section the caller supplied ride along, since the row is written before
  // the student has an account and nothing else can fill them in.
  const metadataByEmail = new Map(targets.map((t) => [t.email, t]))
  await appendEmailInviteRows(
    client,
    { org, classroom },
    invited.map(({ email, role }) => {
      const target = metadataByEmail.get(email)
      return {
        email,
        role,
        first_name: target?.first_name,
        last_name: target?.last_name,
        section: target?.section,
      }
    }),
  )

  return { invited, skipped, failed, deferred }
}
