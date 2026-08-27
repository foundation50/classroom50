import type { GitHubClient } from "@/github-core/client"
import {
  createGitCommit,
  createGitTree,
  updateRef,
} from "@/github-core/mutations"
import { withGitConflictRetry, assertClassroomNotArchived } from "../classrooms"
import { getRawFile } from "@/github-core/queries"
import {
  getBranchRef,
  getCommit,
  getConfigRepoBranch,
} from "@/github-core/configRepoReads"
import { rosterClaimSet } from "@/util/identity"
import { parseGitHubId, resolveGitHubId } from "@/util/students"
import { normalizeInviteEmail } from "@/util/inviteTeam"
import { prefixCommit } from "@/util/commit"
import {
  normalizeStudentRow,
  parseStudentsCsv,
  stringifyStudentsCsv,
  type StudentCsvRow,
} from "@/util/rosterCsv"
import { rosterPath } from "@/util/rosterPath"
import {
  log,
  rosterWriteTree,
  resolveClassroomTeamSlugs,
  listClassroomMembersWithRoles,
} from "./rosterPrimitives"
import type { InviteReconcileState, RecoveredInvite } from "./inviteRecoveries"
import {
  collectInviteRecoveries,
  pendingInviteEmails,
} from "./inviteRecoveries"

export type SyncRosterFromTeamResult = {
  // Team members newly appended to roster.csv as metadata rows.
  addedUsernames: string[]
  // Recovered invited emails folded onto rows (identity filled or appended).
  recoveredEmails: string[]
  // Email-only rows removed because no live invite team backs them.
  removedEmails: string[]
  // Mappings recovered by the in-closure re-collect (a student who accepted
  // AFTER the caller's collect pass), unknown to the caller's invite state.
  // Returned so reconcileRoster can finalize (delete) their teams too once
  // this commit has landed; a caller that ignores them just leaves the teams
  // for the next pass to re-recover idempotently.
  lateRecovered: RecoveredInvite[]
  // No missing members, no role changes, no invite fold — nothing committed.
  noop: boolean
}

// Sync roster.csv from the classroom's GitHub teams — plus, when the caller
// passes the invite-reconcile state, fold the email-invite lifecycle into the
// SAME single commit (see reconcileRoster):
//   1. upgrade rows matched by a recovered invite (fill username/github_id
//      onto the email row written at invite time);
//   2. remove email-only rows (no username, no valid github_id) that no live
//      invite backs — the invite expired, was GC'd, or was cancelled by a path
//      whose own row write failed. A cancel normally drops the row itself, so
//      this is the backstop, not the mechanism. Gated on `invites.trusted` so a
//      degraded read can never wipe pending rows, and every candidate is
//      re-confirmed against GitHub's current pending invitations inside this
//      closure (collect's snapshot predates the CSV read, so an invite sent in
//      between must not be reaped);
//   3. the pre-existing team sync: ensure every active member has an IDENTITY
//      row (username + github_id) carrying their team-derived `role`, refresh
//      changed roles, and backfill resolvable ids.
// The teams are the source of truth for enrollment and role; the CSV holds
// teacher-supplied metadata plus this best-effort snapshot, so identity, role,
// and the recovered email are the only fields written — never name/section
// fabricated from a GitHub profile. Identity rows are never removed (CSV-only
// identity rows are drift, not deletions); only dead email-ONLY rows are.
//
// The diff is recomputed INSIDE the retried closure (re-reading both teams and
// CSV each attempt) so a 409 retry or concurrent edit can't reintroduce or
// duplicate rows. A member unknown to both the CSV and the caller's invite
// state triggers one decision-time re-collect of the invite teams before any
// append — a student who accepted AFTER the caller's collect must be folded
// onto their invite-time row, never appended as a duplicate (#756). Uses the
// same github_id -> username -> email fallback join as the roster view when
// deciding "missing", so a pre-resolution row with an empty github_id isn't
// treated as missing (which would append a duplicate).
export async function syncRosterFromTeam(
  client: GitHubClient,
  input: {
    org: string
    classroom: string
    // Invite-reconcile state from collectInviteRecoveries. Omitted = plain
    // team sync: no removals, and folds only what a decision-time re-collect
    // (triggered by an unknown member) proves.
    invites?: InviteReconcileState
  },
): Promise<SyncRosterFromTeamResult> {
  const { org, classroom, invites } = input
  log.info("sync roster from team: started", { org, classroom })
  await assertClassroomNotArchived(client, org, classroom)

  const slugs = await resolveClassroomTeamSlugs(client, org, classroom)

  return withGitConflictRetry(async () => {
    const [{ members, fullyRead, pendingRoleKeys }, configBranch] =
      await Promise.all([
        listClassroomMembersWithRoles(client, org, slugs),
        getConfigRepoBranch(client, org),
      ])
    const ref = await getBranchRef(client, org, configBranch)
    const commit = await getCommit(client, org, ref.object.sha)

    const studentsFilePath = rosterPath(classroom)
    const currentCsv = await getRawFile(client, {
      org,
      path: studentsFilePath,
      ref: ref.object.sha,
    })
    const currentStudents = parseStudentsCsv(currentCsv)

    // --- Invite fold: claim each recovered mapping onto its row -------------
    // Match by the invited email first (the row written at invite time), then
    // by id/login (a teacher may have added an identity row separately). Each
    // mapping claims at most one row; borrow-only writes (blank fields filled,
    // teacher values win). A mapping with no row at all is appended below with
    // its email attached.
    const foldInvites = (recovered: RecoveredInvite[]) => {
      const recByEmail = new Map(recovered.map((r) => [r.email, r]))
      const recById = new Map(recovered.map((r) => [String(r.invitee.id), r]))
      const recByLogin = new Map(
        recovered.map((r) => [r.invitee.login.toLowerCase(), r]),
      )
      const claimed = new Set<RecoveredInvite>()
      const recoveredEmails: string[] = []
      let inviteFolds = 0
      const foldedStudents = currentStudents.map((s) => {
        const emailKey = normalizeInviteEmail(s.email ?? "")
        const idKey = parseGitHubId(s.github_id)
        const match =
          (emailKey ? recByEmail.get(emailKey) : undefined) ??
          (idKey !== null ? recById.get(String(idKey)) : undefined) ??
          recByLogin.get(s.username.trim().toLowerCase())
        if (!match || claimed.has(match)) return s
        claimed.add(match)
        const next = normalizeStudentRow({
          ...s,
          username: s.username || match.invitee.login,
          github_id: s.github_id || String(match.invitee.id),
          email: s.email?.trim() || match.email,
        })
        if (
          next.username !== s.username ||
          next.github_id !== s.github_id ||
          next.email !== s.email
        ) {
          inviteFolds++
          recoveredEmails.push(match.email)
          return next
        }
        return s
      })
      return {
        recovered,
        recByEmail,
        foldedStudents,
        recoveredEmails,
        inviteFolds,
        unclaimed: recovered.filter((r) => !claimed.has(r)),
      }
    }

    let inviteState = invites
    let fold = foldInvites(inviteState?.recovered ?? [])

    // --- Late-acceptance re-collect ------------------------------------------
    // A member no roster row identifies and no recovered mapping covers is
    // usually a student who accepted BETWEEN the caller's collect pass and this
    // closure's team read (their invite team read as member-less then). Acting
    // on the stale state would append an identity-only duplicate of their
    // pending email row and strand that row for the reaper — the corruption of
    // issue #756 — so re-collect once at decision time and fold with the fresh
    // state. Genuinely new members (added to the team out of band) still fall
    // through to the append below, at the cost of this one extra collect.
    const hasUnknownMember = (f: ReturnType<typeof foldInvites>) => {
      const { ids, logins } = rosterClaimSet(f.foldedStudents)
      const recIds = new Set(f.recovered.map((r) => String(r.invitee.id)))
      return members.some(
        (m) =>
          !ids.has(String(m.id)) &&
          !logins.has(m.login.toLowerCase()) &&
          !recIds.has(String(m.id)),
      )
    }
    let lateRecovered: RecoveredInvite[] = []
    if (hasUnknownMember(fold)) {
      const fresh = await collectInviteRecoveries(client, { org, classroom })
      const known = new Set((invites?.recovered ?? []).map((r) => r.slug))
      lateRecovered = fresh.recovered.filter((r) => !known.has(r.slug))
      inviteState = fresh
      fold = foldInvites(fresh.recovered)
    }
    const { foldedStudents, recByEmail, recoveredEmails, unclaimed } = fold
    const inviteFolds = fold.inviteFolds

    // --- Dead email-row removal ---------------------------------------------
    // An email-ONLY row (no username, no valid github_id) exists on the roster
    // only while a live invite backs it; once the invite is cancelled, expired,
    // or GC'd, the row goes too — in this same commit. Removals are exclusive
    // to the full reconcile (the caller passed its invite state): a plain team
    // sync proves nothing about the invite lifecycle. Two further gates keep
    // one from eating a legitimate row: the invite-reconcile state must be
    // trustworthy (a degraded invite-team read must never masquerade as "no
    // live invites"), and every candidate is confirmed against GitHub's CURRENT
    // pending invitations. That confirmation is read HERE, inside the retried
    // closure, because the collect pass snapshotted teams BEFORE this CSV read
    // — an invite sent in between has its fresh row in `currentStudents` but no
    // entry in the snapshot, and must not be reaped for it.
    const deadRows = new Set<StudentCsvRow>()
    if (invites && inviteState?.trusted) {
      for (const s of foldedStudents) {
        if (s.username.trim()) continue
        if (resolveGitHubId(s.github_id) !== null) continue
        const emailKey = normalizeInviteEmail(s.email ?? "")
        if (!emailKey) continue // a blank junk row is not this pass's call
        if (inviteState.liveInviteEmails.has(emailKey)) continue
        if (recByEmail.has(emailKey)) continue
        deadRows.add(s)
      }
    }
    // Only pay for the confirmation read when something is actually up for
    // removal. A failed read yields null and keeps every row (fail closed).
    const stillPending =
      deadRows.size > 0 ? await pendingInviteEmails(client, org) : null
    const removedEmails: string[] = []
    const keptStudents = foldedStudents.filter((s) => {
      if (!deadRows.has(s)) return true
      const emailKey = normalizeInviteEmail(s.email ?? "")
      if (!stillPending || stillPending.has(emailKey)) return true
      removedEmails.push(emailKey)
      return false
    })

    const { ids, logins } = rosterClaimSet(keptStudents)
    // Email set mirrors buildTeamRoster's indexCsv.byEmail fold: a member whose
    // GitHub email matches an existing (e.g., pre-resolution, id/login-less) CSV
    // row is the SAME person the view folds by email, so appending would create
    // a duplicate email-colliding row the view masks but that breaks email-keyed
    // logic (match-by-email, invite dedupe).
    const emails = new Set(
      keptStudents
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
    //    to "" (e.g., a TA removed from the staff team; the stale "ta" must not
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
    // than guess. A VALID existing id is never overwritten (a renamed login must
    // not silently repoint an id onto a different account); a cell that addresses
    // no account is, since repointing it can't hijack one.
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
    const reconciledStudents = keptStudents.map((s) => {
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
      // Canonicalize a cell that already addresses an account (a zero-padded
      // one) from its OWN digits; only a cell addressing no account falls back
      // to the login, where a recycled login could otherwise repoint the row
      // onto a different person.
      const canonicalId = parseGitHubId(s.github_id)
      const resolvedId = resolveGitHubId(s.github_id)
      let backfilledId: string | undefined
      if (canonicalId !== null) backfilledId = undefined
      else if (resolvedId !== null) backfilledId = String(resolvedId)
      else if (loginKey) backfilledId = idByLogin.get(loginKey)

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

    if (
      missing.length === 0 &&
      roleChanges === 0 &&
      idBackfills === 0 &&
      inviteFolds === 0 &&
      removedEmails.length === 0
    ) {
      log.info("sync roster from team: completed (up to date)", {
        org,
        classroom,
      })
      return {
        addedUsernames: [],
        recoveredEmails: [],
        removedEmails: [],
        lateRecovered,
        noop: true,
      }
    }

    // Identity + role rows: username + github_id + role, plus the recovered
    // invited email when this member arrived via an email invite whose row is
    // gone (the common case leaves the invite-time row in place and upgrades
    // it above). Name/section are left for the teacher (via Edit or a roster
    // upload); we never fabricate profile fields from the GitHub account here.
    const emailByMemberId = new Map(
      unclaimed.map((r) => [String(r.invitee.id), r.email]),
    )
    const addedRows = missing.map((m) => {
      const recoveredEmail = emailByMemberId.get(String(m.id))
      if (recoveredEmail) recoveredEmails.push(recoveredEmail)
      return normalizeStudentRow({
        username: m.login,
        first_name: "",
        last_name: "",
        email: recoveredEmail ?? "",
        section: "",
        github_id: String(m.id),
        role: m.role,
      })
    })

    const nextCsv = stringifyStudentsCsv([...reconciledStudents, ...addedRows])

    const tree = await createGitTree(client, {
      org,
      base_tree: commit.tree.sha,
      tree: rosterWriteTree(classroom, nextCsv),
    })

    const newCommit = await createGitCommit(client, {
      org,
      message: prefixCommit(`Sync roster from teams: ${classroom}`),
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
      inviteFolds,
      removedEmails: removedEmails.length,
    })
    return {
      addedUsernames: addedRows.map((r) => r.username),
      recoveredEmails,
      removedEmails,
      lateRecovered,
      noop: false,
    }
  })
}
