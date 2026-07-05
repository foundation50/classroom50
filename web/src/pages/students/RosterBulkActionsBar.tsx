import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Send, UserMinus, X } from "lucide-react"

import type { GitHubClient } from "@/hooks/github/client"
import { ConfirmModal } from "@/components/modals"
import { GitHubAPIError } from "@/hooks/github/errors"
import { resendOrgInvitation, getErrorMessage } from "@/hooks/github/mutations"
import {
  bulkUnenrollRoster,
  type BulkUnenrollRosterResult,
} from "@/pages/students/bulkUnenrollRoster"
import type { TeamRosterRow } from "@/util/teamRoster"

type Phase = "idle" | "working" | "complete" | "error"
type Progress = { processed: number; total: number; message: string }

type ResultView = {
  headline: string
  sections: {
    title: string
    rows: { key: string; label: string; detail?: string }[]
  }[]
}

const ResultSection = ({
  title,
  rows,
}: {
  title: string
  rows: { key: string; label: string; detail?: string }[]
}) => (
  <div>
    <h4 className="mb-2 font-semibold">{title}</h4>
    <div className="max-h-48 overflow-auto rounded-box border border-base-300">
      <table className="table table-sm">
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>
                <code>{row.label}</code>
              </td>
              <td className="opacity-70">{row.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
)

const buildUnenrollResult = (
  res: BulkUnenrollRosterResult,
  t: ReturnType<typeof useTranslation>["t"],
): ResultView => {
  const removed = res.outcomes.filter((o) => o.status === "removed")
  const skipped = res.outcomes.filter((o) => o.status === "skipped")
  const failed = res.outcomes.filter((o) => o.status === "failed")
  const sections: ResultView["sections"] = []
  if (skipped.length > 0) {
    sections.push({
      title: t("students.bulk.resultSkipped"),
      rows: skipped.map((o) => ({
        key: o.key,
        label: o.label,
        detail: o.detail,
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
  onDone: (action: "unenroll" | "resend") => void
}) => {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()

  const [action, setAction] = useState<"unenroll" | "resend" | null>(null)
  const [phase, setPhase] = useState<Phase>("idle")
  const [progress, setProgress] = useState<Progress>({
    processed: 0,
    total: 0,
    message: "",
  })
  const [result, setResult] = useState<ResultView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmingUnenroll, setConfirmingUnenroll] = useState(false)

  const hasSelection = selectedRows.length > 0
  const pendingSelected = selectedRows.filter((r) => r.state === "pending")

  const isOpen = phase !== "idle"
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (isOpen && !dialog.open) dialog.showModal()
    if (!isOpen && dialog.open) dialog.close()
  }, [isOpen])

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
      console.error(err)
      setError(getErrorMessage(err))
      setPhase("error")
    }
  }

  const runResend = async () => {
    if (pendingSelected.length === 0) return
    setAction("resend")
    setPhase("working")
    setError(null)
    setResult(null)
    setProgress({
      processed: 0,
      total: pendingSelected.length,
      message: t("students.bulk.starting"),
    })
    const resent: string[] = []
    const skipped: { key: string; label: string; detail?: string }[] = []
    const failed: { key: string; label: string; detail?: string }[] = []
    let rateLimited = false
    let processed = 0
    for (const row of pendingSelected) {
      const label = row.username || row.email
      const inviteeId = Number(row.github_id)
      if (!Number.isFinite(inviteeId) || inviteeId <= 0 || !row.username) {
        skipped.push({ key: row.key, label, detail: t("students.bulk.noInviteId") })
        processed += 1
        setProgress({ processed, total: pendingSelected.length, message: label })
        continue
      }
      try {
        const outcome = await resendOrgInvitation(client, {
          org,
          username: row.username,
          inviteeId,
          invitationId: row.invitation_id,
        })
        if (outcome.state === "invited") resent.push(row.key)
        else skipped.push({ key: row.key, label })
      } catch (err) {
        failed.push({ key: row.key, label, detail: getErrorMessage(err) })
        if (err instanceof GitHubAPIError && err.isRateLimited) {
          rateLimited = true
          break
        }
      }
      processed += 1
      setProgress({ processed, total: pendingSelected.length, message: label })
    }

    const sections: ResultView["sections"] = []
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
              resent: resent.length,
            }),
          },
        ],
      })
    setResult({
      headline: t("students.bulk.resentHeadline", { count: resent.length }),
      sections,
    })
    setPhase("complete")
    onDone("resend")
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

        {hasSelection ? (
          <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
            <div className="join">
              <button
                type="button"
                className="btn btn-sm join-item"
                disabled={pendingSelected.length === 0}
                title={
                  pendingSelected.length === 0
                    ? t("students.bulk.resendNoPending")
                    : t("students.bulk.resendSelected", {
                        count: pendingSelected.length,
                      })
                }
                onClick={() => void runResend()}
              >
                <Send aria-hidden="true" className="size-4" />
                {t("students.bulk.resend")}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost join-item text-error hover:bg-error/10"
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
              </button>
            </div>

            <button
              type="button"
              className="btn btn-sm btn-ghost btn-square"
              aria-label={t("students.bulk.clearSelection")}
              title={t("students.bulk.clearSelection")}
              onClick={onClearSelection}
            >
              <X aria-hidden="true" className="size-4" />
            </button>
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

      <dialog
        ref={dialogRef}
        className="modal"
        aria-labelledby={titleId}
        onCancel={(event) => {
          if (phase === "working") {
            event.preventDefault()
            return
          }
          closeModal()
        }}
      >
        <div className="modal-box max-w-2xl">
          <div className="flex items-start justify-between gap-4">
            <h3 id={titleId} className="text-lg font-bold">
              {action === "resend"
                ? t("students.bulk.resendTitle")
                : t("students.bulk.unenrollTitle")}
            </h3>
            {phase !== "working" && (
              <button
                type="button"
                className="btn btn-sm btn-circle btn-ghost"
                aria-label={t("common.close")}
                onClick={closeModal}
              >
                <X size={16} aria-hidden="true" />
              </button>
            )}
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
              <div className="alert mt-6">
                <span>{t("students.bulk.keepTabOpen")}</span>
              </div>
            </div>
          )}

          {phase === "complete" && result && (
            <div className="mt-6 space-y-4">
              <div className="alert alert-success">
                <span>{result.headline}</span>
              </div>
              {result.sections.map((section) => (
                <ResultSection
                  key={section.title}
                  title={section.title}
                  rows={section.rows}
                />
              ))}
              <div className="modal-action">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={closeModal}
                >
                  {t("students.bulk.done")}
                </button>
              </div>
            </div>
          )}

          {phase === "error" && (
            <div className="mt-6">
              <div className="alert alert-error" role="alert">
                <span>{error ?? t("students.somethingWentWrong")}</span>
              </div>
              <div className="modal-action">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={closeModal}
                >
                  {t("common.close")}
                </button>
              </div>
            </div>
          )}
        </div>

        {phase !== "working" && (
          <form method="dialog" className="modal-backdrop">
            <button type="button" onClick={closeModal}>
              {t("common.close")}
            </button>
          </form>
        )}
      </dialog>
    </>
  )
}

export default RosterBulkActionsBar
