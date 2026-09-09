import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  PaperAirplaneIcon,
  SignOutIcon,
  TrashIcon,
  XCircleIcon,
} from "@/components/ui/icons"

import type { GitHubClient } from "@/github-core/client"
import { ConfirmModal } from "@/components/modals"
import { BulkSelectionCluster } from "@/components/bulk/BulkSelectionCluster"
import { useDeferredRun } from "@/hooks/useDeferredRun"
import { DropdownMenu } from "@/components/ui"
import { GitHubAPIError } from "@/github-core/errors"
import { cancelOrgInvitation } from "@/github-core/mutations"
import { getErrorMessage } from "@/github-core/errorMessage"
import {
  bulkUnenrollRoster,
  type BulkUnenrollRosterResult,
} from "@/domain/roster/bulkUnenrollRoster"
import {
  inviteRosterStudents,
  reinviteEmailRows,
  resendClassroomInvite,
  retireEmailInvites,
  removeUnlinkedRows,
  unlinkedRowRef,
} from "@/domain/students"
import { isMalformedGitHubId, resolveGitHubId } from "@/util/students"
import { sortRolesByRank } from "@/util/teamRoster"
import { BulkRunModal, type BulkResultView } from "@/components/bulk/resultView"
import { useBulkRun } from "@/components/bulk/useBulkRun"
import type { TeamRosterRow } from "@/util/teamRoster"
import { canTargetForUnenroll } from "@/util/classroomRoleUI"
import { logger } from "@/lib/logger"

const log = logger.scope("students:RosterBulkActionsBar")

// The three "add students" affordances (Add / Upload / Invite). The page owns
// the modals and renders the trigger buttons in the roster toolbar; the type
// lives here next to the bulk bar they used to sit in.
export type AddStudentActions = {
  onAddStudent: () => void
  onUploadRoster: () => void
  onInviteLinks: () => void
}

const buildUnenrollResult = (
  res: BulkUnenrollRosterResult,
  t: ReturnType<typeof useTranslation>["t"],
): BulkResultView => {
  const removed = res.outcomes.filter((o) => o.status === "removed")
  const skipped = res.outcomes.filter((o) => o.status === "skipped")
  const failed = res.outcomes.filter((o) => o.status === "failed")
  const sections: BulkResultView["sections"] = []
  if (skipped.length > 0) {
    sections.push({
      title: t("students.bulk.resultSkipped"),
      rows: skipped.map((o) => ({
        key: o.key,
        label: o.label,
        // `detail` is a stable reason token from bulkUnenrollRoster; translate
        // it at the render boundary (raw tokens bypass the CI en.json audit and
        // can't be localized), matching the pending path's noInviteId handling.
        detail:
          o.detail === "already-removed"
            ? t("students.bulk.alreadyRemoved")
            : o.detail,
      })),
    })
  }
  if (failed.length > 0) {
    sections.push({
      title: t("students.bulk.resultFailed"),
      rows: failed.map((o) => ({
        key: o.key,
        label: o.label,
        detail: o.detail,
      })),
    })
  }
  if (res.warnings.length > 0) {
    sections.push({
      title: t("students.bulk.resultWarnings"),
      rows: res.warnings.map((message, i) => ({
        key: `warning-${i}`,
        label: message,
      })),
    })
  }
  return {
    headline: t("students.bulk.unenrolledHeadline", { count: removed.length }),
    sections,
  }
}

// Roster multi-select actions: the toolbar's selection cluster (count + one
// "Actions" menu with Send invitations / Cancel invitations / Unenroll /
// Remove rows + Clear), shown only while rows are selected. Owns one
// progress -> results <dialog> shared by all runs. On completion it calls
// onDone so the page can refresh its roster/invite caches.
const RosterBulkActionsBar = ({
  org,
  classroom,
  client,
  selectedRows,
  onClearSelection,
  onRetainSelection,
  onDone,
  disabled = false,
}: {
  org: string
  classroom: string
  client: GitHubClient
  selectedRows: TeamRosterRow[]
  onClearSelection: () => void
  // Narrow the page's selection to these row keys. Each action calls it with
  // its eligible rows before opening its confirm, so the dialog's count, the
  // rows the run touches, and the ticked checkboxes are the same set; a
  // cancelled confirm leaves that narrowed selection in place.
  onRetainSelection: (keys: Iterable<string>) => void
  // Called after a run completes so the page can invalidate roster + invite
  // caches. `action` distinguishes what changed; on an unenroll run the removed
  // rows are passed so the page can suppress the automatic backfills from
  // re-adding them.
  onDone: (
    action: "unenroll" | "invite" | "cancel" | "removeRows",
    removed?: Array<Pick<TeamRosterRow, "username">>,
  ) => void
  // Freeze every control (a roster sync is rewriting the state these actions
  // read/write). A <fieldset disabled> so keyboard activation is off too.
  disabled?: boolean
}) => {
  const { t } = useTranslation()

  const [action, setAction] = useState<
    "unenroll" | "invite" | "cancel" | "removeRows" | null
  >(null)
  const bulk = useBulkRun()
  const { progress } = bulk
  const [confirmingUnenroll, setConfirmingUnenroll] = useState(false)
  const [confirmingInvite, setConfirmingInvite] = useState(false)
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const [confirmingRemoveRows, setConfirmingRemoveRows] = useState(false)

  const hasSelection = selectedRows.length > 0
  const pendingSelected = selectedRows.filter((r) => r.state === "pending")
  // "Send invitations" covers every row that can receive a fresh org invite,
  // in three lanes that share one run and one result dialog:
  //   - a pending row with a GitHub account: cancel + recreate by id;
  //   - an email row (a pending email-only invite, or an unlinked address
  //     whose invitation died or expired): cancel/dismiss + recreate by address;
  //   - a roster row with a GitHub account that isn't in the org (including
  //     one whose invitation expired): a fresh invite by id.
  const loginResendSelected = pendingSelected.filter((r) => r.username)
  const emailReinviteSelected = selectedRows.filter(
    (r) =>
      !r.username &&
      r.email.trim() &&
      (r.state === "pending" || r.state === "unlinked"),
  )
  const notInOrgSelected = selectedRows.filter(
    (r) => r.state === "needs_attention_not_in_org" && r.username,
  )
  const invitableRows = [
    ...loginResendSelected,
    ...emailReinviteSelected,
    ...notInOrgSelected,
  ]
  const invitableSelected = invitableRows.length
  // Cancellable = pending rows that carry an org-invitation id.
  const cancellableSelected = pendingSelected.filter(
    (r) => typeof r.invitation_id === "number",
  )
  // Unenroll can only target a row the roster matcher can find. A selection may
  // now mix an email-only pending invite (cancellable, not unenrollable) with
  // ordinary rows, so filter rather than sending the whole selection and letting
  // the writer silently report the pending ones as "already removed".
  const unenrollableSelected = selectedRows.filter(canTargetForUnenroll)
  // Unlinked rows (no GitHub identity) are the bulk remove-rows target; the
  // email-carrying ones are also re-invitable above.
  const unlinkedSelected = selectedRows.filter((r) => r.state === "unlinked")

  // Visibility is its own flag: closing must not reset phase/result/action
  // (close-animation note in ui/Modal); each run resets them anyway.
  const [isOpen, setModalOpen] = useState(false)

  // Opening an action's confirm first narrows the selection to the rows that
  // action can touch. The menu label already showed "(N)" against M selected;
  // this makes the checkboxes match, so the dialog never says "5" over a table
  // showing 12 ticks, and a cancelled confirm leaves the honest 5 behind.
  const beginAction = (
    eligible: TeamRosterRow[],
    setConfirming: (open: boolean) => void,
  ) => {
    onRetainSelection(eligible.map((r) => r.key))
    setConfirming(true)
  }
  const withCount = (label: string, count: number) =>
    t("common.actionWithCount", { label, count })

  const deferRun = useDeferredRun()

  const closeModal = () => {
    if (bulk.busy) return
    setModalOpen(false)
  }

  const runUnenroll = async () => {
    // Re-check the freeze at the run boundary: the confirm modal renders
    // OUTSIDE the disabled fieldset (it must survive a selection clear), so a
    // dialog opened before a sync armed could otherwise fire mid-sync.
    if (disabled) return
    if (unenrollableSelected.length === 0) return
    if (!bulk.begin(unenrollableSelected.length, t("students.bulk.starting")))
      return
    setAction("unenroll")
    setModalOpen(true)
    try {
      const res = await bulkUnenrollRoster(client, {
        org,
        classroom,
        rows: unenrollableSelected,
        onProgress: bulk.setProgress,
      })
      bulk.complete(buildUnenrollResult(res, t), "complete")
      // Pass only the CONFIRMED-removed rows so the page suppresses the
      // automatic backfills for exactly those (a still-active org member left by
      // a classroom-scoped unenroll would otherwise be team-added back). Rows
      // that matched nothing (already gone) are not suppressed.
      const removedKeys = new Set(
        res.outcomes.filter((o) => o.status === "removed").map((o) => o.key),
      )
      onDone(
        "unenroll",
        unenrollableSelected
          .filter((r) => removedKeys.has(r.key))
          .map((r) => ({ username: r.username })),
      )
    } catch (err) {
      log.error("bulk unenroll failed", { err, record: true })
      bulk.fail(getErrorMessage(err))
    }
  }

  const runInvite = async () => {
    if (disabled) return
    if (invitableSelected === 0) return
    if (!bulk.begin(invitableSelected, t("students.bulk.starting"))) return
    setAction("invite")
    setModalOpen(true)

    type Outcome = { key: string; label: string; detail?: string }
    const invited: Outcome[] = []
    const skipped: Outcome[] = []
    const failed: Outcome[] = []
    const deferred: Outcome[] = []
    let rateLimited = false
    let processed = 0
    const tick = (label: string) => {
      processed += 1
      bulk.setProgress({ processed, total: invitableSelected, message: label })
    }
    // The batch lanes report their own progress from zero; offset it by the
    // rows already done so the dialog counts up once, across lanes.
    const laneProgress =
      (base: number) => (p: { processed: number; message: string }) => {
        processed = base + p.processed
        bulk.setProgress({
          processed,
          total: invitableSelected,
          message: p.message,
        })
      }

    // Lane 1: pending rows with a GitHub account: cancel + recreate by id.
    for (const row of loginResendSelected) {
      const label = row.username
      // Once GitHub rate-limits us, stop issuing new resends (hammering only
      // extends the throttle) and defer the rest for a later retry.
      if (rateLimited) {
        deferred.push({ key: row.key, label })
        tick(label)
        continue
      }
      const inviteeId = resolveGitHubId(row.github_id)
      if (inviteeId === null) {
        skipped.push({
          key: row.key,
          label,
          detail: isMalformedGitHubId(row.github_id)
            ? t("students.bulk.malformedInviteId")
            : t("students.bulk.noInviteId"),
        })
        tick(label)
        continue
      }
      try {
        const role = sortRolesByRank(row.roles)[0] ?? "student"
        const outcome = await resendClassroomInvite(client, {
          org,
          classroom,
          username: row.username,
          inviteeId,
          invitationId: row.invitation_id,
          role,
        })
        if (outcome.state === "invited") invited.push({ key: row.key, label })
        else
          skipped.push({
            key: row.key,
            label,
            detail: t("students.bulk.alreadyInvitedOrMember"),
          })
      } catch (err) {
        // A 429 is deferred (never failed) — mirroring the deferred bucket in
        // inviteRosterStudents — and flips the flag so the remaining rows are
        // deferred too rather than hammering a throttled endpoint.
        if (err instanceof GitHubAPIError && err.isRateLimited) {
          rateLimited = true
          deferred.push({ key: row.key, label })
        } else {
          log.debug("bulk resend: per-row invite failed", { err })
          failed.push({ key: row.key, label, detail: getErrorMessage(err) })
        }
      }
      tick(label)
    }

    // Lanes 2 and 3 each send one batch through a domain recipe that reports
    // four buckets keyed by an address or a login. One runner owns the shared
    // shape: pre-defer the whole lane once a rate limit was hit, offset its
    // progress, fold the buckets, and classify a thrown 429 as deferred rather
    // than failed so the next lane stops too. A thrown precondition (archived
    // classroom, unresolvable team) sent nothing, so every row is reported
    // rather than the lane being lost silently.
    const runBatchLane = async <K extends string>(
      rows: TeamRosterRow[],
      keyOf: (row: TeamRosterRow) => K,
      send: (onProgress: ReturnType<typeof laneProgress>) => Promise<{
        invited: K[]
        skipped: K[]
        failed: { key: K; message: string }[]
        deferred: K[]
      }>,
    ) => {
      if (rows.length === 0) return
      const byKey = new Map(rows.map((r) => [keyOf(r).toLowerCase(), r]))
      const outcome = (k: K, detail?: string): Outcome => {
        const row = byKey.get(k.toLowerCase())
        return { key: row?.key ?? k, label: k, detail }
      }
      const base = processed
      if (rateLimited) {
        for (const row of rows) deferred.push(outcome(keyOf(row)))
      } else {
        try {
          const res = await send(laneProgress(base))
          for (const k of res.invited) invited.push(outcome(k))
          for (const k of res.skipped)
            skipped.push(outcome(k, t("students.bulk.alreadyInvitedOrMember")))
          for (const f of res.failed) failed.push(outcome(f.key, f.message))
          if (res.deferred.length > 0) rateLimited = true
          for (const k of res.deferred) deferred.push(outcome(k))
        } catch (err) {
          log.debug("bulk invite: batch lane failed", { err })
          if (err instanceof GitHubAPIError && err.isRateLimited) {
            rateLimited = true
            for (const row of rows) deferred.push(outcome(keyOf(row)))
          } else {
            const detail = getErrorMessage(err)
            for (const row of rows) failed.push(outcome(keyOf(row), detail))
          }
        }
      }
      processed = base + rows.length
      bulk.setProgress({
        processed,
        total: invitableSelected,
        message: t("students.bulk.starting"),
      })
    }

    // Lane 2: email rows. The recipe cancels a live invitation right before
    // its create and dismisses failed records only after a confirmed send.
    await runBatchLane(
      emailReinviteSelected,
      (row) => row.email.trim(),
      async (onProgress) => {
        const res = await reinviteEmailRows(client, {
          org,
          classroom,
          targets: emailReinviteSelected.map((row) => ({
            email: row.email,
            role: sortRolesByRank(row.roles)[0] ?? "student",
            pendingInvitationId:
              row.state === "pending" ? row.invitation_id : undefined,
            failedInvitationId: row.failed_invitation?.id,
          })),
          onProgress,
        })
        return {
          invited: res.invited.map((i) => i.email),
          skipped: res.skipped.map((s) => s.email),
          failed: res.failed.map((f) => ({ key: f.email, message: f.message })),
          deferred: res.deferred,
        }
      },
    )

    // Lane 3: roster rows with an account that isn't in the org: fresh invite
    // by id; the attributed failed record is dismissed once the invite is out.
    await runBatchLane(
      notInOrgSelected,
      (row) => row.username,
      async (onProgress) => {
        const res = await inviteRosterStudents(client, {
          org,
          classroom,
          students: notInOrgSelected.map((row) => ({
            username: row.username,
            github_id: row.github_id,
            role: sortRolesByRank(row.roles)[0] ?? "student",
            failedInvitationId: row.failed_invitation?.id,
          })),
          onProgress,
        })
        return {
          invited: res.invited.map((i) => i.username),
          skipped: res.skipped.map((s) => s.username),
          failed: res.failed.map((f) => ({
            key: f.username,
            message: f.message,
          })),
          deferred: res.deferred,
        }
      },
    )

    const sections: BulkResultView["sections"] = []
    if (skipped.length > 0)
      sections.push({ title: t("students.bulk.resultSkipped"), rows: skipped })
    if (failed.length > 0)
      sections.push({ title: t("students.bulk.resultFailed"), rows: failed })
    if (deferred.length > 0)
      sections.push({
        title: t("students.bulk.resultWarnings"),
        rows: [
          {
            key: "rate-limited",
            label: t("students.resendAllRateLimitedShort", {
              resent: invited.length,
            }),
          },
          ...deferred,
        ],
      })
    bulk.complete(
      {
        headline: t("students.bulk.invitedHeadline", { count: invited.length }),
        sections,
      },
      "complete",
    )
    onDone("invite")
  }

  const runCancel = async () => {
    if (disabled) return
    if (cancellableSelected.length === 0) return
    const total = cancellableSelected.length
    if (!bulk.begin(total, t("students.bulk.starting"))) return
    setAction("cancel")
    setModalOpen(true)

    const cancelled: { key: string; label: string }[] = []
    const alreadyGone: { key: string; label: string }[] = []
    const failed: { key: string; label: string; detail?: string }[] = []
    // Addresses whose invitation this pass actually revoked. A stale id (404 ->
    // `alreadyGone`) is deliberately excluded: it does NOT mean the person has no
    // live invitation. resendOrgInvitation recreates before cancelling, so a view
    // that hasn't refetched — or another teacher's session — holds an old id
    // while a fresh invitation for the same address is still pending. Retiring
    // the row there would delete the invite-time name/section for someone who can
    // still accept, leaving them to land as a blank identity row.
    const retiredEmails: string[] = []
    let processed = 0
    for (const row of cancellableSelected) {
      const label = row.username || row.email
      try {
        // Non-null: cancellableSelected is filtered on a numeric invitation_id.
        const { cancelled: didCancel } = await cancelOrgInvitation(client, {
          org,
          invitationId: row.invitation_id as number,
        })
        // A 404 means the id was stale (e.g., a resend already replaced it), so
        // report it as "already gone" rather than a phantom cancellation.
        if (didCancel) cancelled.push({ key: row.key, label })
        else alreadyGone.push({ key: row.key, label })
        if (didCancel && !row.username && row.email) {
          retiredEmails.push(row.email)
        }
      } catch (err) {
        log.debug("bulk cancel: per-row cancel failed", { err })
        failed.push({ key: row.key, label, detail: getErrorMessage(err) })
      }
      processed += 1
      bulk.setProgress({ processed, total, message: label })
    }

    // An email-only invite leaves a metadata team holding the address and a
    // pending roster row; retire both for the ones actually revoked. Runs after
    // the loop so the batch makes ONE roster commit (never throws — the GC and
    // reconcile passes are the backstops).
    await retireEmailInvites(client, {
      org,
      classroom,
      emails: retiredEmails,
    })

    const sections: BulkResultView["sections"] = []
    if (alreadyGone.length > 0)
      sections.push({
        title: t("students.bulk.cancelAlreadyGone"),
        rows: alreadyGone,
      })
    if (failed.length > 0)
      sections.push({ title: t("students.bulk.resultFailed"), rows: failed })
    bulk.complete(
      {
        headline: t("students.bulk.cancelledHeadline", {
          count: cancelled.length,
        }),
        sections,
      },
      "complete",
    )
    onDone("cancel")
  }

  const runRemoveRows = async () => {
    if (disabled) return
    if (unlinkedSelected.length === 0) return
    if (!bulk.begin(unlinkedSelected.length, t("students.bulk.starting")))
      return
    setAction("removeRows")
    setModalOpen(true)
    try {
      // One commit for the whole batch; rows that gained an identity since the
      // selection are skipped server-side and reported as missed.
      const res = await removeUnlinkedRows(client, {
        org,
        classroom,
        rowRefs: unlinkedSelected.map((r) => unlinkedRowRef(r)),
      })
      bulk.setProgress({
        processed: unlinkedSelected.length,
        total: unlinkedSelected.length,
        message: "",
      })
      const sections: BulkResultView["sections"] = []
      if (res.missed > 0) {
        sections.push({
          title: t("students.bulk.resultSkipped"),
          rows: [
            {
              key: "removeRowsMissed",
              label: t("students.bulk.removeRowsMissed", {
                count: res.missed,
              }),
            },
          ],
        })
      }
      bulk.complete(
        {
          headline: t("students.bulk.removedRowsHeadline", {
            count: res.removed,
          }),
          sections,
        },
        "complete",
      )
      onDone("removeRows")
    } catch (err) {
      log.error("bulk remove unlinked rows failed", { err, record: true })
      bulk.fail(getErrorMessage(err))
    }
  }

  return (
    <>
      {/* The selection cluster lives in the page toolbar and appears only
          while rows are selected: count, one consolidated Actions menu, and
          Clear. The modals below stay mounted regardless, so a completing
          run's result dialog survives the selection clearing out from under
          it. display:contents keeps the pieces direct flex children of the
          toolbar while the fieldset still freezes them during a sync. */}
      {hasSelection ? (
        <fieldset disabled={disabled} className="contents">
          <BulkSelectionCluster
            countLabel={t("students.bulk.selectedCount", {
              count: selectedRows.length,
            })}
            onClearSelection={onClearSelection}
          >
            <DropdownMenu.Item
              icon={PaperAirplaneIcon}
              label={withCount(t("students.bulk.invite"), invitableSelected)}
              disabled={invitableSelected === 0}
              title={
                invitableSelected === 0
                  ? t("students.bulk.inviteNoneInvitable")
                  : t("students.bulk.inviteSelected", {
                      count: invitableSelected,
                    })
              }
              onSelect={() => beginAction(invitableRows, setConfirmingInvite)}
            />
            <DropdownMenu.Item
              icon={XCircleIcon}
              label={withCount(
                t("students.bulk.cancelInvite"),
                cancellableSelected.length,
              )}
              disabled={cancellableSelected.length === 0}
              title={
                cancellableSelected.length === 0
                  ? t("students.bulk.cancelNoneCancellable")
                  : t("students.bulk.cancelSelected", {
                      count: cancellableSelected.length,
                    })
              }
              onSelect={() =>
                beginAction(cancellableSelected, setConfirmingCancel)
              }
            />
            {/* Unenroll — destructive, so last and in its own group. */}
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              icon={SignOutIcon}
              label={withCount(
                t("students.bulk.unenroll"),
                unenrollableSelected.length,
              )}
              destructive
              disabled={unenrollableSelected.length === 0}
              title={t("students.bulk.unenrollSelected", {
                count: unenrollableSelected.length,
              })}
              onSelect={() =>
                beginAction(unenrollableSelected, setConfirmingUnenroll)
              }
            />
            {/* Remove unlinked rows — the roster-only delete for rows with
                no GitHub identity. Rendered only when the selection contains
                such rows, so the menu doesn't grow a dead entry. */}
            {unlinkedSelected.length > 0 ? (
              <DropdownMenu.Item
                icon={TrashIcon}
                label={withCount(
                  t("students.bulk.removeRows"),
                  unlinkedSelected.length,
                )}
                destructive
                title={t("students.bulk.removeRowsSelected", {
                  count: unlinkedSelected.length,
                })}
                onSelect={() =>
                  beginAction(unlinkedSelected, setConfirmingRemoveRows)
                }
              />
            ) : null}
          </BulkSelectionCluster>
        </fieldset>
      ) : null}

      <ConfirmModal
        open={confirmingUnenroll && !disabled}
        tone="error"
        warning={t("students.bulk.confirmUnenrollWarning")}
        needsConfirm={false}
        title={t("students.bulk.confirmUnenrollTitle", {
          count: unenrollableSelected.length,
        })}
        description={t("students.bulk.confirmUnenrollBody", {
          count: unenrollableSelected.length,
        })}
        confirmLabel={t("students.bulk.unenroll")}
        onConfirm={async () => {
          setConfirmingUnenroll(false)
          deferRun(runUnenroll)
        }}
        onClose={() => setConfirmingUnenroll(false)}
      />

      <ConfirmModal
        open={confirmingInvite && !disabled}
        tone="warning"
        needsConfirm={false}
        title={t("students.bulk.confirmInviteTitle", {
          count: invitableSelected,
        })}
        description={t("students.bulk.confirmInviteBodyPlain", {
          count: invitableSelected,
        })}
        confirmLabel={t("students.bulk.invite")}
        onConfirm={async () => {
          setConfirmingInvite(false)
          deferRun(runInvite)
        }}
        onClose={() => setConfirmingInvite(false)}
      />

      <ConfirmModal
        open={confirmingRemoveRows && !disabled}
        tone="warning"
        needsConfirm={false}
        title={t("students.bulk.confirmRemoveRowsTitle", {
          count: unlinkedSelected.length,
        })}
        description={t("students.bulk.confirmRemoveRowsBody", {
          count: unlinkedSelected.length,
        })}
        confirmLabel={t("students.bulk.removeRows")}
        onConfirm={async () => {
          setConfirmingRemoveRows(false)
          deferRun(runRemoveRows)
        }}
        onClose={() => setConfirmingRemoveRows(false)}
      />

      <ConfirmModal
        open={confirmingCancel && !disabled}
        tone="error"
        needsConfirm={false}
        title={t("students.bulk.confirmCancelTitle", {
          count: cancellableSelected.length,
        })}
        description={t("students.bulk.confirmCancelBody", {
          count: cancellableSelected.length,
        })}
        confirmLabel={t("students.bulk.cancelInviteConfirm", {
          count: cancellableSelected.length,
        })}
        onConfirm={async () => {
          setConfirmingCancel(false)
          deferRun(runCancel)
        }}
        onClose={() => setConfirmingCancel(false)}
      />

      <BulkRunModal
        open={isOpen}
        onClose={closeModal}
        run={bulk}
        title={
          action === "invite"
            ? t("students.bulk.inviteTitle")
            : action === "cancel"
              ? t("students.bulk.cancelTitle")
              : action === "removeRows"
                ? t("students.bulk.removeRowsTitle")
                : t("students.bulk.unenrollTitle")
        }
        processedCaption={t("students.bulk.progressProcessed", {
          processed: progress.processed,
          total: progress.total,
        })}
        keepTabOpenMessage={t("students.bulk.keepTabOpen")}
        fallbackError={t("students.somethingWentWrong")}
        doneLabel={t("students.bulk.done")}
      />
    </>
  )
}

export default RosterBulkActionsBar
