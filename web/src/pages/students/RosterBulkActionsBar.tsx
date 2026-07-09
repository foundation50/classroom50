import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { Plus, Send, Upload, UserMinus, X } from "lucide-react"

import type { GitHubClient } from "@/hooks/github/client"
import { ConfirmModal } from "@/components/modals"
import { Alert, Button, Modal } from "@/components/ui"
import { GitHubAPIError } from "@/hooks/github/errors"
import { resendOrgInvitation, getErrorMessage } from "@/hooks/github/mutations"
import {
  bulkUnenrollRoster,
  type BulkUnenrollRosterResult,
} from "@/pages/students/bulkUnenrollRoster"
import {
  inviteRosterStudents,
  type InviteRosterStudentsResult,
} from "@/api/mutations/students"
import { parseGitHubId } from "@/util/students"
import {
  BulkResultSection,
  type BulkPhase,
  type BulkProgress,
  type BulkResultView,
} from "@/components/bulk/resultView"
import type { TeamRosterRow } from "@/util/teamRoster"
import { logger } from "@/lib/logger"

const log = logger.scope("students:RosterBulkActionsBar")

// The three "add students" affordances the toolbar surfaces (when nothing is
// selected). The page owns the modals; the bar just triggers them, keeping the
// controls adjacent to the table rather than floating in the page header.
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

// Roster multi-select toolbar: select-all header + count label, and — once a
// selection exists — Resend (pending subset only) / Unenroll / Clear. Owns its
// progress -> results <dialog> for the unenroll run. Resend routes its per-row
// outcomes into the same results modal. On completion it calls onDone so the
// page can refresh its roster/invite caches.
const RosterBulkActionsBar = ({
  org,
  classroom,
  client,
  selectedRows,
  totalCount,
  allSelected,
  someSelected,
  onToggleSelectAll,
  onClearSelection,
  onDone,
  addActions,
  groupBySection,
  onGroupBySectionChange,
  canGroupBySection = false,
}: {
  org: string
  classroom: string
  client: GitHubClient
  selectedRows: TeamRosterRow[]
  totalCount: number
  allSelected: boolean
  someSelected: boolean
  onToggleSelectAll: () => void
  onClearSelection: () => void
  // Called after a run completes so the page can invalidate roster + invite
  // caches. `action` distinguishes what changed.
  onDone: (action: "unenroll" | "invite") => void
  // The "add students" triggers shown on the right when nothing is selected.
  addActions?: AddStudentActions
  // Group-by-section toggle, rendered in the header next to the count. Shown
  // only when canGroupBySection (the filtered rows have >=1 section).
  groupBySection?: boolean
  onGroupBySectionChange?: (value: boolean) => void
  canGroupBySection?: boolean
}) => {
  const { t } = useTranslation()
  const titleId = useId()

  const [action, setAction] = useState<"unenroll" | "invite" | null>(null)
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

  const hasSelection = selectedRows.length > 0
  const pendingSelected = selectedRows.filter((r) => r.state === "pending")
  const notInOrgSelected = selectedRows.filter((r) => r.state === "not_in_org")
  // Both pending (resend) and not_in_org (fresh invite) rows are "invitable".
  const invitableSelected = pendingSelected.length + notInOrgSelected.length
  // not_in_org rows with no stored github_id are invited by resolving the
  // current holder of the username (GET /users/{login}). A recycled/renamed
  // login could resolve to a stranger, so inviting them is gated behind a
  // confirmation that names the risk (see the invite button below).
  const idlessInviteCount = notInOrgSelected.filter(
    (r) => !r.github_id?.trim(),
  ).length

  const isOpen = phase !== "idle"

  const closeModal = () => {
    if (phase === "working") return
    setPhase("idle")
    setResult(null)
    setError(null)
    setAction(null)
  }

  const runUnenroll = async () => {
    if (selectedRows.length === 0) return
    setAction("unenroll")
    setPhase("working")
    setError(null)
    setResult(null)
    setProgress({
      processed: 0,
      total: selectedRows.length,
      message: t("students.bulk.starting"),
    })
    try {
      const res = await bulkUnenrollRoster(client, {
        org,
        classroom,
        rows: selectedRows,
        onProgress: setProgress,
      })
      setResult(buildUnenrollResult(res, t))
      setPhase("complete")
      onDone("unenroll")
    } catch (err) {
      log.error("bulk unenroll failed", { err, record: true })
      setError(getErrorMessage(err))
      setPhase("error")
    }
  }

  const runInvite = async () => {
    if (invitableSelected === 0) return
    setAction("invite")
    setPhase("working")
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
    let rateLimited = false
    let processed = 0
    const tick = (label: string) => {
      processed += 1
      setProgress({ processed, total: invitableSelected, message: label })
    }

    // Pending rows: cancel + re-send the existing invite (resendOrgInvitation).
    for (const row of pendingSelected) {
      const label = row.username || row.email
      const inviteeId = parseGitHubId(row.github_id)
      if (inviteeId === null || !row.username) {
        skipped.push({
          key: row.key,
          label,
          detail: t("students.bulk.noInviteId"),
        })
        tick(label)
        continue
      }
      try {
        const outcome = await resendOrgInvitation(client, {
          org,
          username: row.username,
          inviteeId,
          invitationId: row.invitation_id,
        })
        if (outcome.state === "invited") invited.push({ key: row.key, label })
        else skipped.push({ key: row.key, label })
      } catch (err) {
        log.debug("bulk resend: per-row invite failed", { err })
        failed.push({ key: row.key, label, detail: getErrorMessage(err) })
        if (err instanceof GitHubAPIError && err.isRateLimited) {
          rateLimited = true
          break
        }
      }
      tick(label)
    }

    // not_in_org rows: send a FRESH org invite (resolve id from username when
    // the CSV has no github_id), carrying the classroom team. Skipped when a
    // rate limit already halted the pending pass.
    if (!rateLimited && notInOrgSelected.length > 0) {
      try {
        const res: InviteRosterStudentsResult = await inviteRosterStudents(
          client,
          {
            org,
            classroom,
            students: notInOrgSelected.map((r) => ({
              username: r.username,
              github_id: r.github_id,
            })),
            onProgress: ({ message }) => tick(message),
          },
        )
        const keyFor = (username: string) =>
          notInOrgSelected.find((r) => r.username === username)?.key ?? username
        for (const u of res.invited) invited.push({ key: keyFor(u), label: u })
        for (const s of res.skipped)
          skipped.push({
            key: keyFor(s.username),
            label: s.username,
            detail:
              s.reason === "already-member"
                ? t("students.bulk.alreadyMember")
                : t("students.bulk.alreadyPending"),
          })
        for (const f of res.failed)
          failed.push({
            key: keyFor(f.username),
            label: f.username,
            detail: f.message,
          })
        // A rate limit inside the fresh-invite pass leaves the remaining rows
        // deferred; surface them and flag the run so the rate-limit warning
        // renders (mirrors the pending-pass break above).
        if (res.deferred.length > 0) {
          rateLimited = true
          for (const u of res.deferred)
            skipped.push({
              key: keyFor(u),
              label: u,
              detail: t("students.bulk.rateLimitedDeferred"),
            })
        }
      } catch (err) {
        setError(getErrorMessage(err))
        setPhase("error")
        return
      }
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
        ],
      })
    setResult({
      headline: t("students.bulk.invitedHeadline", { count: invited.length }),
      sections,
    })
    setPhase("complete")
    onDone("invite")
  }

  const progressPercent =
    progress.total === 0
      ? 0
      : Math.round((progress.processed / progress.total) * 100)

  return (
    <>
      <div
        className={`flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-base-300 px-6 py-3 transition-colors ${
          hasSelection ? "bg-base-200/60" : ""
        }`}
      >
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            className="checkbox checkbox-sm"
            aria-label={t("students.bulk.selectAll")}
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected && !allSelected
            }}
            onChange={onToggleSelectAll}
          />
          <span className="text-sm font-medium tabular-nums">
            {hasSelection
              ? t("students.bulk.selectedCount", { count: selectedRows.length })
              : t("students.bulk.studentCount", { count: totalCount })}
          </span>
        </label>

        {canGroupBySection && onGroupBySectionChange ? (
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-base-content/70">
            <input
              type="checkbox"
              className="toggle toggle-sm"
              checked={Boolean(groupBySection)}
              onChange={(e) => onGroupBySectionChange(e.target.checked)}
            />
            {t("students.groupBySection")}
          </label>
        ) : null}

        {hasSelection ? (
          <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
            <div className="join">
              <Button
                size="sm"
                className="join-item"
                disabled={invitableSelected === 0}
                title={
                  invitableSelected === 0
                    ? t("students.bulk.inviteNoneInvitable")
                    : t("students.bulk.inviteSelected", {
                        count: invitableSelected,
                      })
                }
                onClick={() => setConfirmingInvite(true)}
              >
                <Send aria-hidden="true" className="size-4" />
                {t("students.bulk.invite")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="join-item text-error hover:bg-error/10"
                aria-label={t("students.bulk.unenrollSelected", {
                  count: selectedRows.length,
                })}
                title={t("students.bulk.unenrollSelected", {
                  count: selectedRows.length,
                })}
                onClick={() => setConfirmingUnenroll(true)}
              >
                <UserMinus aria-hidden="true" className="size-4" />
                {t("students.bulk.unenroll")}
              </Button>
            </div>

            <Button
              variant="ghost"
              size="sm"
              shape="square"
              aria-label={t("students.bulk.clearSelection")}
              title={t("students.bulk.clearSelection")}
              onClick={onClearSelection}
            >
              <X aria-hidden="true" className="size-4" />
            </Button>
          </div>
        ) : addActions ? (
          <div className="join ml-auto">
            <Button
              size="sm"
              className="join-item"
              aria-label={t("students.addTitle")}
              title={t("students.addTitle")}
              onClick={addActions.onAddStudent}
            >
              <Plus aria-hidden="true" className="size-4" />
            </Button>
            <Button
              size="sm"
              className="join-item"
              aria-label={t("students.uploadRosterTitle")}
              title={t("students.uploadRosterTitle")}
              onClick={addActions.onUploadRoster}
            >
              <Upload aria-hidden="true" className="size-4" />
            </Button>
            <Button
              size="sm"
              className="join-item"
              aria-label={t("students.inviteStudents")}
              title={t("students.inviteStudents")}
              onClick={addActions.onInviteLinks}
            >
              <Send aria-hidden="true" className="size-4" />
            </Button>
          </div>
        ) : null}
      </div>

      <ConfirmModal
        open={confirmingUnenroll}
        dangerous
        needsConfirm={false}
        title={t("students.bulk.confirmUnenrollTitle", {
          count: selectedRows.length,
        })}
        description={t("students.bulk.confirmUnenrollBody", {
          count: selectedRows.length,
        })}
        confirmLabel={t("students.bulk.unenroll")}
        onConfirm={async () => {
          setConfirmingUnenroll(false)
          setTimeout(() => void runUnenroll(), 0)
        }}
        onClose={() => setConfirmingUnenroll(false)}
      />

      <ConfirmModal
        open={confirmingInvite}
        dangerous={false}
        needsConfirm={false}
        title={t("students.bulk.confirmInviteTitle", {
          count: invitableSelected,
        })}
        description={t(
          idlessInviteCount > 0
            ? "students.bulk.confirmInviteBody"
            : "students.bulk.confirmInviteBodyPlain",
          {
            count:
              idlessInviteCount > 0 ? idlessInviteCount : invitableSelected,
          },
        )}
        confirmLabel={t("students.bulk.invite")}
        onConfirm={async () => {
          setConfirmingInvite(false)
          setTimeout(() => void runInvite(), 0)
        }}
        onClose={() => setConfirmingInvite(false)}
      />

      <Modal
        open={isOpen}
        onClose={closeModal}
        closeDisabled={phase === "working"}
        size="2xl"
        aria-labelledby={titleId}
      >
        <div className="flex items-start justify-between gap-4">
          <h3 id={titleId} className="text-lg font-bold">
            {action === "invite"
              ? t("students.bulk.inviteTitle")
              : t("students.bulk.unenrollTitle")}
          </h3>
        </div>

        {phase === "working" && (
          <div className="mt-6">
            <p className="mb-2 font-medium">{progress.message}</p>
            <progress
              className="progress progress-primary w-full"
              value={progress.processed}
              max={progress.total || 1}
            />
            <div className="mt-2 flex justify-between text-sm opacity-70">
              <span>
                {t("students.bulk.progressProcessed", {
                  processed: progress.processed,
                  total: progress.total,
                })}
              </span>
              <span>{progressPercent}%</span>
            </div>
            <Alert tone="info" className="mt-6">
              <span>{t("students.bulk.keepTabOpen")}</span>
            </Alert>
          </div>
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
            <div className="modal-action">
              <Button variant="primary" onClick={closeModal}>
                {t("students.bulk.done")}
              </Button>
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="mt-6">
            <Alert tone="error">
              <span>{error ?? t("students.somethingWentWrong")}</span>
            </Alert>
            <div className="modal-action">
              <Button variant="ghost" onClick={closeModal}>
                {t("common.close")}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}

export default RosterBulkActionsBar
