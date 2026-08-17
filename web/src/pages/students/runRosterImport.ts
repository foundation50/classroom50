import {
  applyClassroomRoleChange,
  bulkEnrollStudentsInClassroom,
  bulkInviteByEmail,
  inviteRosterStudents,
  NoNewStudentsError,
  repairRosterUsernames,
  RosterCsvMalformedError,
  updateClassroomMetadata,
  writeClassroomRoles,
  type BulkImportResult,
  type BulkInviteByEmailResult,
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
  metadataWritebackMalformed: string
  metadataWritebackFailed: string
  invitingEmails: string
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
      // The email-invite pass's result, when the batch carried email-identity
      // rows. Null when it carried none.
      emailResult: BulkInviteByEmailResult | null
      // A hard failure of the email pass. The roster write already landed, so
      // this is surfaced on the completed screen rather than replacing it.
      emailError: string | null
    }

// The roster-import flow. Runs up to two pipelines SEQUENTIALLY over one shared
// roster.csv: account rows (write rows + team-add members, invite non-members,
// write back roles/metadata, apply confirmed team moves), then email rows (org
// invitations that each land a pending row). Extracted from UploadRoster so the
// multi-step sequencing is reasoned about (and tested) apart from the modal's
// phase/setState wiring. The caller owns all React state; this returns the
// outcomes to map onto it. `onProgress` streams the same progress shape the
// component renders.
//
// The passes are never concurrent: every step here is a read-modify-write on the
// same branch ref, so overlapping them would contend for it.
export async function runRosterImport(
  client: GitHubClient,
  params: {
    org: string
    classroom: string
    rows: ImportRosterRow[]
    // Email-identity rows, each already carrying the role the teacher assigned
    // and any name/section the file supplied. Empty for an account-only file.
    emailInvites?: {
      email: string
      role: ClassroomRole
      first_name?: string
      last_name?: string
      section?: string
    }[]
    // The classification computed in the preview, snapshotted so the process
    // pass matches exactly what the teacher confirmed. Its identityMismatches
    // are the confirmed stale-username repairs.
    plan: PreflightResult | null
    onProgress: (progress: ImportProgress) => void
    messages: RosterImportMessages
  },
): Promise<RosterImportOutcome> {
  const {
    org,
    classroom,
    rows,
    emailInvites = [],
    plan,
    onProgress,
    messages,
  } = params

  // Every write below joins on the immutable account when the preview resolved
  // one, rather than a login that may be stale.
  const rowByLogin = new Map(rows.map((r) => [r.username.toLowerCase(), r]))

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
  //
  //    Skipped entirely for an email-only file: addStudentsToClassroom requires
  //    at least one username, so calling it with no account rows would fail a
  //    batch that has real work to do in the email pass below.
  let importResult: BulkImportResult = {
    addedStudents: [],
    skippedStudents: [],
  }
  if (rows.length > 0) {
    try {
      importResult = await bulkEnrollStudentsInClassroom(client, {
        org,
        classroom,
        rows,
        onProgress,
      })
    } catch (err) {
      // NoNewStudentsError means every row already exists in roster.csv. Benign:
      // keep the empty result so the completed view renders, and fall through to
      // the invite pass so a previously rate-limited student is re-invited.
      if (!(err instanceof NoNewStudentsError)) {
        log.error("roster import failed", { err, record: true })
        return {
          ok: false,
          error: err instanceof Error ? err.message : messages.importFailed,
        }
      }
    }
  }

  let inviteOutcome: InviteOutcome | null = null
  let inviteError: string | null = null
  let roleChangeOutcome: RoleChangeOutcome | null = null
  let emailResult: BulkInviteByEmailResult | null = null
  let emailError: string | null = null

  // 1.5) Repair a stale stored username BEFORE any login-keyed write below. The
  //    teacher confirmed these in the preview: the row's github_id resolved to a
  //    different login than the file declared, which means the student renamed
  //    their account. Nothing else in the app repairs this (the reconcile fills a
  //    blank username but never repoints an existing one), so without it the role
  //    writeback below would keep missing the row and the same warning would
  //    reappear on every future upload. Best-effort — a failure only means the
  //    id-keyed writes still land while the stored login stays stale.
  const usernameRepairs = (plan?.identityMismatches ?? []).map((m) => ({
    github_id: m.github_id,
    username: m.username,
  }))
  if (usernameRepairs.length > 0) {
    try {
      await repairRosterUsernames(client, {
        org,
        classroom,
        repairs: usernameRepairs,
      })
    } catch (err) {
      log.warn("roster username repair failed", { err, record: true })
    }
  }

  // 2) The team is the source of truth for who shows on the roster, so send org
  //    invites for uploaded students who aren't already members — they then
  //    appear as a `pending` row. Invite the FULL uploaded set (not just the
  //    newly-added rows): inviteRosterStudents no-ops anyone already
  //    active/pending, so a re-run after a rate limit still re-invites a student
  //    whose first invite was deferred (their CSV row already exists, so they'd
  //    otherwise be skipped as a duplicate and, since CSV-only rows don't
  //    render, silently lost). Thread the github_id — the one the preview
  //    resolved, else the one the enroll pass just captured — so the invite
  //    targets the immutable account rather than re-resolving a possibly
  //    recycled/renamed login. Their roster.csv row enriches the pending row;
  //    deferred/failed invites are surfaced in the result dialog.
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
  const resolvedIdFor = (username: string): string =>
    rowByLogin.get(username.toLowerCase())?.github_id ??
    idByLogin.get(username.toLowerCase()) ??
    ""
  if (rows.length > 0 && !plan?.allAlreadyMembers) {
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
          github_id: resolvedIdFor(r.username),
          role: r.role ?? "student",
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
      github_id: resolvedIdFor(r.username) || undefined,
      role: r.role ?? "student",
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

  // 3.5) Persist changed name/email/section back to roster.csv for members the
  //    preflight flagged with a metadata delta (metadata_update, plus role_change
  //    / enroll rows that also carry one — all surfaced and confirmed in the
  //    preview before we get here). Only rows with a genuine delta are folded in,
  //    so a pure team move never enters this write. Runs AFTER the role writeback
  //    commits so this RMW sees the role change; best-effort — a failure converges
  //    on the next sync and never blocks invites or team moves.
  const metadataOutcomes = [
    ...(plan?.metadataUpdate ?? []),
    ...(plan?.roleChanges ?? []).filter((c) => c.changedFields.length > 0),
    ...(plan?.enroll ?? []).filter((e) => e.changedFields.length > 0),
  ]
  const metadataUpdates = metadataOutcomes
    .map((o) => rowByLogin.get(o.username.toLowerCase()))
    .filter((r): r is ImportRosterRow => Boolean(r))
    .map((r) => ({
      username: r.username,
      github_id: resolvedIdFor(r.username) || undefined,
      first_name: r.first_name,
      last_name: r.last_name,
      email: r.email,
      section: r.section,
    }))
  if (metadataUpdates.length > 0) {
    try {
      await updateClassroomMetadata(client, {
        org,
        classroom,
        updates: metadataUpdates,
      })
    } catch (err) {
      if (err instanceof RosterCsvMalformedError) {
        inviteError = inviteError ?? messages.metadataWritebackMalformed
      } else {
        inviteError = inviteError ?? messages.metadataWritebackFailed
      }
      log.warn("roster metadata writeback failed", { err, record: true })
    }
  }

  // 4) Apply the CONFIRMED team assignments the preflight identified:
  //    - role_change: an active member on a DIFFERENT classroom team -> move
  //      them (drop every non-target team; teacher target grants org owner, a
  //      demotion off teacher revokes it). Gated behind the confirmation
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
          github_id: resolvedIdFor(move.username) || undefined,
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

  // 5) Send the email-identity rows' invitations LAST, after every account-row
  //    write has committed. Each successful invite lands a pending roster row
  //    carrying the name/section the file supplied, so the teacher's metadata
  //    survives even though the student has no GitHub account yet.
  //
  //    Wrapped rather than thrown: bulkInviteByEmail throws outright when a
  //    role's team can't be resolved, and by this point the roster write has
  //    already landed — dropping the teacher onto the bare error screen would
  //    hide it. Surface the failure on the completed screen instead, the way the
  //    account invite pass already does.
  if (emailInvites.length > 0) {
    onProgress({
      processed: 0,
      total: emailInvites.length,
      message: messages.invitingEmails,
    })
    try {
      emailResult = await bulkInviteByEmail(client, {
        org,
        classroom,
        invites: emailInvites,
        onProgress,
      })
    } catch (err) {
      log.error("roster email invite pass failed", { err, record: true })
      emailError = err instanceof Error ? err.message : messages.importFailed
    }
  }

  return {
    ok: true,
    importResult,
    inviteOutcome,
    inviteError,
    roleChangeOutcome,
    emailResult,
    emailError,
  }
}
