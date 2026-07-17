import {
  applyClassroomRoleChange,
  bulkEnrollStudentsInClassroom,
  inviteRosterStudents,
  NoNewStudentsError,
  RosterCsvMalformedError,
  writeClassroomRoles,
  type BulkImportResult,
  type ImportRosterRow,
} from "@/domain/students"
import type { GitHubClient } from "@/github-core/client"
import type { PreflightResult } from "@/util/rosterUploadPreflight"
import type { ClassroomRole } from "@/util/teamRoster"
import { logger } from "@/lib/logger"

const log = logger.scope("students:runRosterImport")

export type ImportProgress = {
  processed: number
  total: number
  message: string
}

export type InviteOutcome = {
  invited: { username: string; role: ClassroomRole }[]
  deferred: string[]
  failed: { username: string; message: string }[]
}

export type RoleChangeOutcome = {
  changed: { username: string; to: ClassroomRole }[]
  failed: { username: string; message: string }[]
}

// Translated status/warning strings, passed in so this orchestrator stays
// t()-free (mirrors the hooks/mutations messages-bag convention).
export type RosterImportMessages = {
  startingImport: string
  invitingUploaded: string
  processRoleChanges: string
  importFailed: string
  roleWritebackMalformed: string
  roleWritebackFailed: string
}

// The full roster-import outcome. On a hard enroll failure (nothing written) the
// caller shows the error screen; otherwise the roster.csv write landed and the
// caller shows the completed view even if a later pass reported a soft warning.
export type RosterImportOutcome =
  | { ok: false; error: string }
  | {
      ok: true
      importResult: BulkImportResult
      inviteOutcome: InviteOutcome | null
      inviteError: string | null
      roleChangeOutcome: RoleChangeOutcome | null
    }

// The roster-CSV import flow (username/CSV upload branch): write roster.csv +
// team-add existing members, invite non-members, write back assigned roles, and
// apply the confirmed team moves the preflight identified. Extracted from
// UploadRoster so the multi-step sequencing is reasoned about (and tested) apart
// from the modal's phase/setState wiring. The caller owns all React state; this
// returns the outcomes to map onto it. `onProgress` streams the same progress
// shape the component renders.
export async function runRosterImport(
  client: GitHubClient,
  params: {
    org: string
    classroom: string
    rows: ImportRosterRow[]
    rolesByUser: Record<string, ClassroomRole>
    // The classification computed in the preview, snapshotted so the process
    // pass matches exactly what the teacher confirmed.
    plan: PreflightResult | null
    onProgress: (progress: ImportProgress) => void
    messages: RosterImportMessages
  },
): Promise<RosterImportOutcome> {
  const { org, classroom, rows, rolesByUser, plan, onProgress, messages } =
    params

  onProgress({
    processed: 0,
    total: rows.length,
    message: messages.startingImport,
  })

  // 1) Write the roster.csv rows (identity + name/email/section) and team-add
  //    anyone already an active org member. A re-run where every uploaded row
  //    already exists throws NoNewStudentsError (nothing to commit) — that is
  //    benign here: we still run the invite pass below so a student whose first
  //    invite was rate-limited/failed gets re-invited. Any other enroll error is
  //    a genuine failure (nothing written) -> error screen.
  let importResult: BulkImportResult
  try {
    importResult = await bulkEnrollStudentsInClassroom(client, {
      org,
      classroom,
      rows,
      onProgress,
    })
  } catch (err) {
    if (err instanceof NoNewStudentsError) {
      // All rows already in roster.csv — synthesize an empty result so the
      // completed view still renders, then fall through to the invite pass.
      importResult = { addedStudents: [], skippedStudents: [] }
    } else {
      log.error("roster import failed", { err, record: true })
      return {
        ok: false,
        error: err instanceof Error ? err.message : messages.importFailed,
      }
    }
  }

  let inviteOutcome: InviteOutcome | null = null
  let inviteError: string | null = null
  let roleChangeOutcome: RoleChangeOutcome | null = null

  // 2) The team is the source of truth for who shows on the roster, so send org
  //    invites for uploaded students who aren't already members — they then
  //    appear as a `pending` row. Invite the FULL uploaded set (not just the
  //    newly-added rows): inviteRosterStudents no-ops anyone already
  //    active/pending, so a re-run after a rate limit still re-invites a student
  //    whose first invite was deferred (their CSV row already exists, so they'd
  //    otherwise be skipped as a duplicate and, since CSV-only rows don't
  //    render, silently lost). Thread the github_id the enroll pass just
  //    resolved (from addedStudents, keyed by login) so the invite targets the
  //    immutable account rather than re-resolving a possibly recycled/renamed
  //    login. Their roster.csv row enriches the pending row; deferred/failed
  //    invites are surfaced in the result dialog.
  //
  //    SKIP the invite pass entirely when the preflight found every uploaded
  //    username is already an active org member — there's nothing to invite, so
  //    don't hammer the invite endpoint.
  const idByLogin = new Map(
    importResult.addedStudents.map((s) => [
      s.username.toLowerCase(),
      s.github_id,
    ]),
  )
  if (!plan?.allAlreadyMembers) {
    onProgress({
      processed: 0,
      total: rows.length,
      message: messages.invitingUploaded,
    })
    try {
      const inviteRes = await inviteRosterStudents(client, {
        org,
        classroom,
        students: rows.map((r) => ({
          username: r.username,
          github_id: idByLogin.get(r.username.toLowerCase()) ?? "",
          role: rolesByUser[r.username.toLowerCase()] ?? "student",
        })),
        onProgress,
      })
      inviteOutcome = {
        invited: inviteRes.invited,
        deferred: inviteRes.deferred,
        failed: inviteRes.failed.map((f) => ({
          username: f.username,
          message: f.message,
        })),
      }
    } catch (err) {
      // The roster.csv write already landed; a hard invite failure must not hide
      // it behind the bare error screen. Keep the completed view and show the
      // invite error there — the teacher can re-run to retry the invites.
      log.error("roster invite pass failed", { err, record: true })
      inviteError = err instanceof Error ? err.message : messages.importFailed
    }
  }

  // 3) Persist the assigned role back to roster.csv for EVERY uploaded row, not
  //    just the freshly-invited ones. A row that was deferred (rate limit),
  //    skipped (already a member/pending), or failed still has a teacher-
  //    assigned role and a roster row from step 1 — omitting them would leave
  //    their role blank until a later sync. writeClassroomRoles only touches
  //    existing rows whose role actually changed, so covering the full set is
  //    safe and idempotent. Best-effort: a writeback failure doesn't undo the
  //    invites (role converges on the next sync). A malformed roster.csv is
  //    surfaced distinctly so the teacher fixes it.
  const roleWriteback = rows
    .map((r) => ({
      username: r.username,
      role: rolesByUser[r.username.toLowerCase()] ?? "student",
    }))
    .filter((r) => r.username.trim())
  if (roleWriteback.length > 0) {
    try {
      await writeClassroomRoles(client, {
        org,
        classroom,
        roles: roleWriteback,
      })
    } catch (err) {
      if (err instanceof RosterCsvMalformedError) {
        inviteError = messages.roleWritebackMalformed
      } else {
        // A transient/other writeback failure isn't fatal (the role converges on
        // the next sync), but the completed dialog would otherwise show a bare
        // success — surface a soft warning so the teacher knows the role column
        // didn't persist this run.
        inviteError = messages.roleWritebackFailed
      }
      log.warn("roster role writeback failed", { err, record: true })
    }
  }

  // 4) Apply the CONFIRMED team assignments the preflight identified:
  //    - role_change: an active member on a DIFFERENT classroom team -> move
  //      them (drop every non-target team; instructor target grants org owner, a
  //      demotion off instructor revokes it). Gated behind the confirmation
  //      checkbox in the preview.
  //    - enroll: an active member on NO classroom team -> an additive team-add
  //      onto the CSV role's team (empty fromRoles, so nothing is dropped).
  //    Both route through applyClassroomRoleChange (re-verifies active
  //    membership, never team-adds a non-member). Best-effort per row: a failure
  //    is surfaced in the result dialog, not fatal (the roster write landed).
  const moves: {
    username: string
    fromRoles: ClassroomRole[]
    toRole: ClassroomRole
  }[] = [
    ...(plan?.roleChanges ?? []).map((c) => ({
      username: c.username,
      fromRoles: c.currentRoles,
      toRole: c.role,
    })),
    ...(plan?.enroll ?? []).map((e) => ({
      username: e.username,
      fromRoles: [] as ClassroomRole[],
      toRole: e.role,
    })),
  ]
  if (moves.length > 0) {
    onProgress({
      processed: 0,
      total: moves.length,
      message: messages.processRoleChanges,
    })
    const changed: { username: string; to: ClassroomRole }[] = []
    const failed: { username: string; message: string }[] = []
    let done = 0
    for (const move of moves) {
      try {
        const res = await applyClassroomRoleChange(client, {
          org,
          classroom,
          username: move.username,
          github_id: idByLogin.get(move.username.toLowerCase()),
          fromRoles: move.fromRoles,
          toRole: move.toRole,
        })
        changed.push({ username: res.username, to: res.toRole })
        // A best-effort old-team removal failure is a warning, not a hard
        // failure — surface it alongside so the teacher can retry.
        for (const w of res.warnings) {
          failed.push({ username: move.username, message: w })
        }
      } catch (err) {
        log.error("roster role change failed", { err, record: true })
        failed.push({
          username: move.username,
          message: err instanceof Error ? err.message : String(err),
        })
      } finally {
        done += 1
        onProgress({
          processed: done,
          total: moves.length,
          message: messages.processRoleChanges,
        })
      }
    }
    roleChangeOutcome = { changed, failed }
  }

  return {
    ok: true,
    importResult,
    inviteOutcome,
    inviteError,
    roleChangeOutcome,
  }
}
