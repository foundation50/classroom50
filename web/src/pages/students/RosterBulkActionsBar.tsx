import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  TriangleDownIcon,
  PaperAirplaneIcon,
  SignOutIcon,
  TrashIcon,
  XCircleIcon,
  XIcon,
} from "@/components/ui/icons"

import type { GitHubClient } from "@/github-core/client"
import { ConfirmModal } from "@/components/modals"
import { useDeferredRun } from "@/hooks/useDeferredRun"
import {
  Alert,
  Button,
  DropdownMenu,
  Modal,
  closeDropdownMenu,
} from "@/components/ui"
import { GitHubAPIError } from "@/github-core/errors"
import { cancelOrgInvitation } from "@/github-core/mutations"
import { getErrorMessage } from "@/github-core/errorMessage"
import {
  bulkUnenrollRoster,
  type BulkUnenrollRosterResult,
} from "@/domain/roster/bulkUnenrollRoster"
import {
  resendClassroomInvite,
  retireEmailInvites,
  removeUnlinkedRows,
  unlinkedRowRef,
} from "@/domain/students"
import { isMalformedGitHubId, resolveGitHubId } from "@/util/students"
import { sortRolesByRank } from "@/util/teamRoster"
import {
  BulkProgressRow,
  BulkResultSection,
  bulkProgressPct,
  type BulkPhase,
  type BulkProgress,
  type BulkResultView,
} from "@/components/bulk/resultView"
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
// "Actions" menu with Resend / Cancel invite / Unenroll + Clear), shown only
// while rows are selected. Owns one progress -> results <dialog> shared by all
// three runs. On completion it calls onDone so the page can refresh its
// roster/invite caches.
const RosterBulkActionsBar = ({
  org,
  classroom,
  client,
  selectedRows,
  onClearSelection,
  onDone,
  disabled = false,
}: {
  org: string
  classroom: string
  client: GitHubClient
  selectedRows: TeamRosterRow[]
  onClearSelection: () => void
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
  const [phase, setPhase] = useState<BulkPhase>("idle")
  const [progress, setProgress] = useState<BulkProgress>({
    processed: 0,
    total: 0,
    message: "",
  })
  const [result, setResult] = useState<BulkResultView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmingUnenroll, setConfirmingUnenroll] = useState(false)
  const [confirmingInvite, setConfirmingInvite] = useState(false)
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const [confirmingRemoveRows, setConfirmingRemoveRows] = useState(false)

  const hasSelection = selectedRows.length > 0
  const pendingSelected = selectedRows.filter((r) => r.state === "pending")
  // Only pending rows are "invitable" — the action resends their org invite.
  // (The roster is team-driven; there are no CSV-only rows to freshly invite.)
  const invitableSelected = pendingSelected.length
  // Cancellable = pending rows that carry an org-invitation id.
  const cancellableSelected = pendingSelected.filter(
    (r) => typeof r.invitation_id === "number",
  )
  // Unenroll can only target a row the roster matcher can find. A selection may
  // now mix an email-only pending invite (cancellable, not unenrollable) with
  // ordinary rows, so filter rather than sending the whole selection and letting
  // the writer silently report the pending ones as "already removed".
  const unenrollableSelected = selectedRows.filter(canTargetForUnenroll)
  // Unlinked rows (no GitHub identity): the ONLY bulk action for them is
  // removing the rows themselves — invite/cancel/unenroll are all keyed on an
  // identity or an invitation these rows don't have.
  const unlinkedSelected = selectedRows.filter((r) => r.state === "unlinked")

  // Visibility is its own flag: closing must not reset phase/result/action
  // (close-animation note in ui/Modal); each run resets them anyway.
  const [isOpen, setModalOpen] = useState(false)

  const deferRun = useDeferredRun()

  const closeModal = () => {
    if (phase === "working") return
    setModalOpen(false)
  }

  const runUnenroll = async () => {
    // Re-check the freeze at the run boundary: the confirm modal renders
    // OUTSIDE the disabled fieldset (it must survive a selection clear), so a
    // dialog opened before a sync armed could otherwise fire mid-sync.
    if (disabled) return
    if (unenrollableSelected.length === 0) return
    setAction("unenroll")
    setPhase("working")
    setModalOpen(true)
    setError(null)
    setResult(null)
    setProgress({
      processed: 0,
      total: unenrollableSelected.length,
      message: t("students.bulk.starting"),
    })
    try {
      const res = await bulkUnenrollRoster(client, {
        org,
        classroom,
        rows: unenrollableSelected,
        onProgress: setProgress,
      })
      setResult(buildUnenrollResult(res, t))
      setPhase("complete")
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
      setError(getErrorMessage(err))
      setPhase("error")
    }
  }

  const runInvite = async () => {
    if (disabled) return
    if (invitableSelected === 0) return
    setAction("invite")
    setPhase("working")
    setModalOpen(true)
    setError(null)
    setResult(null)
    setProgress({
      processed: 0,
      total: invitableSelected,
      message: t("students.bulk.starting"),
    })

    const invited: { key: string; label: string; detail?: string }[] = []
    const skipped: { key: string; label: string; detail?: string }[] = []
    const failed: { key: string; label: string; detail?: string }[] = []
    const deferred: { key: string; label: string; detail?: string }[] = []
    let rateLimited = false
    let processed = 0
    const tick = (label: string) => {
      processed += 1
      setProgress({ processed, total: invitableSelected, message: label })
    }

    // Pending rows: cancel + re-send the existing invite (resendOrgInvitation).
    for (const row of pendingSelected) {
      const label = row.username || row.email
      // Once GitHub rate-limits us, stop issuing new resends (hammering only
      // extends the throttle) and defer the rest for a later retry.
      if (rateLimited) {
        deferred.push({ key: row.key, label })
        tick(label)
        continue
      }
      const inviteeId = resolveGitHubId(row.github_id)
      if (inviteeId === null || !row.username) {
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
        else skipped.push({ key: row.key, label })
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

    const sections: BulkResultView["sections"] = []
    if (skipped.length > 0)
      sections.push({ title: t("students.bulk.resultSkipped"), rows: skipped })
    if (failed.length > 0)
      sections.push({ title: t("students.bulk.resultFailed"), rows: failed })
    if (rateLimited)
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
    setResult({
      headline: t("students.bulk.invitedHeadline", { count: invited.length }),
      sections,
    })
    setPhase("complete")
    onDone("invite")
  }

  const runCancel = async () => {
    if (disabled) return
    if (cancellableSelected.length === 0) return
    setAction("cancel")
    setPhase("working")
    setModalOpen(true)
    setError(null)
    setResult(null)
    const total = cancellableSelected.length
    setProgress({ processed: 0, total, message: t("students.bulk.starting") })

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
      setProgress({ processed, total, message: label })
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
    setResult({
      headline: t("students.bulk.cancelledHeadline", {
        count: cancelled.length,
      }),
      sections,
    })
    setPhase("complete")
    onDone("cancel")
  }

  const runRemoveRows = async () => {
    if (disabled) return
    if (unlinkedSelected.length === 0) return
    setAction("removeRows")
    setPhase("working")
    setModalOpen(true)
    setError(null)
    setResult(null)
    setProgress({
      processed: 0,
      total: unlinkedSelected.length,
      message: t("students.bulk.starting"),
    })
    try {
      // One commit for the whole batch; rows that gained an identity since the
      // selection are skipped server-side and reported as missed.
      const res = await removeUnlinkedRows(client, {
        org,
        classroom,
        rowRefs: unlinkedSelected.map((r) => unlinkedRowRef(r)),
      })
      setProgress({
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
      setResult({
        headline: t("students.bulk.removedRowsHeadline", {
          count: res.removed,
        }),
        sections,
      })
      setPhase("complete")
      onDone("removeRows")
    } catch (err) {
      log.error("bulk remove unlinked rows failed", { err, record: true })
      setError(getErrorMessage(err))
      setPhase("error")
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
          <span className="text-sm font-medium tabular-nums">
            {t("students.bulk.selectedCount", { count: selectedRows.length })}
          </span>
          {/* dropdown-start: the cluster sits on the toolbar's left, so the
              menu opens rightward instead of off the edge. */}
          <div className="dropdown dropdown-start">
            <Button variant="primary" size="sm">
              {t("students.bulk.actions")}
              <TriangleDownIcon aria-hidden="true" className="size-4" />
            </Button>
            <DropdownMenu className="w-64">
              <li>
                <button
                  type="button"
                  disabled={invitableSelected === 0}
                  title={
                    invitableSelected === 0
                      ? t("students.bulk.inviteNoneInvitable")
                      : t("students.bulk.inviteSelected", {
                          count: invitableSelected,
                        })
                  }
                  onClick={() => {
                    closeDropdownMenu()
                    if (invitableSelected === 0) return
                    setConfirmingInvite(true)
                  }}
                >
                  <PaperAirplaneIcon aria-hidden="true" className="size-4" />
                  {t("students.bulk.invite")}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  disabled={cancellableSelected.length === 0}
                  title={
                    cancellableSelected.length === 0
                      ? t("students.bulk.cancelNoneCancellable")
                      : t("students.bulk.cancelSelected", {
                          count: cancellableSelected.length,
                        })
                  }
                  onClick={() => {
                    closeDropdownMenu()
                    if (cancellableSelected.length === 0) return
                    setConfirmingCancel(true)
                  }}
                >
                  <XCircleIcon aria-hidden="true" className="size-4" />
                  {t("students.bulk.cancelInvite")}
                </button>
              </li>
              {/* Unenroll — destructive, so last and in its own group. */}
              <DropdownMenu.Separator />
              <li>
                <button
                  type="button"
                  className="text-error"
                  disabled={unenrollableSelected.length === 0}
                  title={t("students.bulk.unenrollSelected", {
                    count: unenrollableSelected.length,
                  })}
                  onClick={() => {
                    closeDropdownMenu()
                    if (unenrollableSelected.length === 0) return
                    setConfirmingUnenroll(true)
                  }}
                >
                  <SignOutIcon aria-hidden="true" className="size-4" />
                  {t("students.bulk.unenroll")}
                </button>
              </li>
              {/* Remove unlinked rows — the roster-only delete for rows with
                  no GitHub identity. Destructive; rendered only when the
                  selection actually contains such rows, so the menu doesn't
                  grow a dead entry for ordinary selections. */}
              {unlinkedSelected.length > 0 ? (
                <li>
                  <button
                    type="button"
                    className="text-error"
                    title={t("students.bulk.removeRowsSelected", {
                      count: unlinkedSelected.length,
                    })}
                    onClick={() => {
                      closeDropdownMenu()
                      setConfirmingRemoveRows(true)
                    }}
                  >
                    <TrashIcon aria-hidden="true" className="size-4" />
                    {t("students.bulk.removeRows")}
                  </button>
                </li>
              ) : null}
            </DropdownMenu>
          </div>
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            aria-label={t("students.bulk.clearSelection")}
            title={t("students.bulk.clearSelection")}
            onClick={onClearSelection}
          >
            <XIcon aria-hidden="true" className="size-4" />
          </Button>
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
        confirmLabel={t("students.bulk.cancelInvite")}
        onConfirm={async () => {
          setConfirmingCancel(false)
          deferRun(runCancel)
        }}
        onClose={() => setConfirmingCancel(false)}
      />

      <Modal
        open={isOpen}
        onClose={closeModal}
        closeDisabled={phase === "working"}
        size="2xl"
        title={
          action === "invite"
            ? t("students.bulk.inviteTitle")
            : action === "cancel"
              ? t("students.bulk.cancelTitle")
              : action === "removeRows"
                ? t("students.bulk.removeRowsTitle")
                : t("students.bulk.unenrollTitle")
        }
        footer={
          phase === "complete" ? (
            <Button variant="primary" onClick={closeModal}>
              {t("students.bulk.done")}
            </Button>
          ) : phase === "error" ? (
            <Button variant="primary" onClick={closeModal}>
              {t("common.done")}
            </Button>
          ) : undefined
        }
      >
        {phase === "working" && (
          <BulkProgressRow
            progress={progress}
            processedCaption={t("students.bulk.progressProcessed", {
              processed: progress.processed,
              total: progress.total,
            })}
            percentCaption={`${bulkProgressPct(progress)}%`}
          >
            <Alert tone="info" className="mt-6">
              <span>{t("students.bulk.keepTabOpen")}</span>
            </Alert>
          </BulkProgressRow>
        )}

        {phase === "complete" && result && (
          <div className="mt-6 space-y-4">
            <Alert tone="success">
              <span>{result.headline}</span>
            </Alert>
            {result.sections.map((section) => (
              <BulkResultSection
                key={section.title}
                title={section.title}
                rows={section.rows}
              />
            ))}
          </div>
        )}

        {phase === "error" && (
          <div className="mt-6">
            <Alert tone="error">
              <span>{error ?? t("students.somethingWentWrong")}</span>
            </Alert>
          </div>
        )}
      </Modal>
    </>
  )
}

export default RosterBulkActionsBar
