import type { GitHubClient } from "@/github-core/client"
import {
  createGitCommit,
  createGitTree,
  updateRef,
} from "@/github-core/mutations"
import { withGitConflictRetry, assertClassroomNotArchived } from "../classrooms"
import { getRawFileWithFallbackSource } from "@/github-core/queries"
import {
  getBranchRef,
  getCommit,
  getConfigRepoBranch,
} from "@/github-core/configRepoReads"
import { rosterClaimSet } from "@/util/identity"
import { prefixCommit } from "@/util/commit"
import {
  normalizeStudentRow,
  parseStudentsCsv,
  stringifyStudentsCsv,
} from "@/util/rosterCsv"
import { rosterPath, legacyRosterPath } from "@/util/rosterPath"
import {
  log,
  rosterWriteTree,
  resolveClassroomTeamSlugs,
  listClassroomMembersWithRoles,
} from "./rosterPrimitives"

export type SyncRosterFromTeamResult = {
  // Team members newly appended to roster.csv as metadata rows.
  addedUsernames: string[]
  // No missing members and no role changes — nothing was committed.
  noop: boolean
}

// Sync roster.csv from the classroom's GitHub teams: ensure every active member
// of the student team plus every staff team (teacher, hta, ta) has an IDENTITY
// row (username +
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
