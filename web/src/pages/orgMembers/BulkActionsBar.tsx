import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Plus, UserMinus, X } from "lucide-react"

import type { GitHubClient } from "@/hooks/github/client"
import type { GitHubUser } from "@/hooks/github/types"
import type { StudentCsvRow } from "@/api/mutations/students"
import type { OrgMemberRow } from "@/util/orgMembers"
import {
  bulkAddToClassroom,
  type BulkAddToClassroomResult,
} from "@/pages/orgMembers/bulkAddToClassroom"
import {
  bulkRemoveFromClassroom,
  type BulkRemoveFromClassroomResult,
} from "@/pages/orgMembers/bulkRemoveFromClassroom"
import { ConfirmModal } from "@/components/modals"

// A classroom option for the picker (the config-repo dir name/path).
export type BulkClassroomOption = { name: string; path: string }

type Phase = "idle" | "working" | "complete" | "error"
type Progress = { processed: number; total: number; message: string }

// A completed run of either action, normalized so the results modal renders one
// shape. `sections` are labeled groups of per-row lines (added / skipped /
// failed etc.).
type ResultView = {
  headline: string
  sections: {
    title: string
    rows: { key: string; label: string; detail?: string }[]
  }[]
}

const buildAddResult = (
  res: BulkAddToClassroomResult,
  classroom: string,
  t: ReturnType<typeof useTranslation>["t"],
): ResultView => {
  const added = res.enroll?.addedStudents ?? []
  const csvSkipped = res.enroll?.skippedStudents ?? []
  const teamFailed = (res.enroll?.teamResults ?? []).filter(
    (r) => r.status === "failed",
  )
  const sections: ResultView["sections"] = []
  if (added.length > 0) {
    sections.push({
      title: t("orgMembers.bulk.resultAdded"),
      rows: added.map((s) => ({
        key: s.username,
        label: s.username,
        detail: [s.first_name, s.last_name].filter(Boolean).join(" "),
      })),
    })
  }
  const skipped = [
    ...res.preSkipped.map((s) => ({
      key: s.key,
      label: s.label,
      detail: t(`orgMembers.bulk.skipReason.${s.reason}`),
    })),
    ...csvSkipped.map((s) => ({
      key: s.username,
      label: s.username,
      detail: s.message ?? s.reason,
    })),
  ]
  if (skipped.length > 0) {
    sections.push({ title: t("orgMembers.bulk.resultSkipped"), rows: skipped })
  }
  if (teamFailed.length > 0) {
    sections.push({
      title: t("orgMembers.bulk.resultTeamFailures"),
      rows: teamFailed.map((r) => ({
        key: r.username,
        label: r.username,
        detail: r.message ?? t("orgMembers.bulk.couldNotAddToTeam"),
      })),
    })
  }
  return {
    headline: t("orgMembers.bulk.addedHeadline", {
      count: added.length,
      classroom,
    }),
    sections,
  }
}

const buildRemoveResult = (
  res: BulkRemoveFromClassroomResult,
  classroom: string,
  t: ReturnType<typeof useTranslation>["t"],
): ResultView => {
  const removed = res.outcomes.filter((o) => o.status === "removed")
  const skipped = res.outcomes.filter((o) => o.status === "skipped")
  const failed = res.outcomes.filter((o) => o.status === "failed")
  const sections: ResultView["sections"] = []
  if (skipped.length > 0) {
    sections.push({
      title: t("orgMembers.bulk.resultSkipped"),
      rows: skipped.map((o) => ({
        key: o.key,
        label: o.label,
        detail: o.detail
          ? t(`orgMembers.bulk.skipReason.${o.detail}`, {
              defaultValue: o.detail,
            })
          : undefined,
      })),
    })
  }
  if (failed.length > 0) {
    sections.push({
      title: t("orgMembers.bulk.resultFailed"),
      rows: failed.map((o) => ({
        key: o.key,
        label: o.label,
        detail: o.detail,
      })),
    })
  }
  // Non-fatal side-effect warnings (team drop / invite cancel) — the roster
  // removal itself still succeeded, so these are informational.
  if (res.warnings.length > 0) {
    sections.push({
      title: t("orgMembers.bulk.resultWarnings"),
      rows: res.warnings.map((message, i) => ({
        key: `warning-${i}`,
        label: message,
      })),
    })
  }
  return {
    headline: t("orgMembers.bulk.removedHeadline", {
      count: removed.length,
      classroom,
    }),
    sections,
  }
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

// The members table's header toolbar. It always shows the select-all checkbox +
// a contextual label; once rows are selected it reveals the classroom picker +
// Add/Remove/Clear actions inline (no separate floating bar, no layout shift —
// the header is always present and only its right side fills in). Owns its own
// run modal (progress -> results) and drives the bulk add/remove orchestrators.
// On a successful run it calls onDone with the rows the server enrolled so the
// page can optimistically seed its caches.
const BulkActionsBar = ({
  org,
  client,
  selectedRows,
  totalCount,
  allSelected,
  someSelected,
  onToggleSelectAll,
  members,
  classrooms,
  onClearSelection,
  onDone,
}: {
  org: string
  client: GitHubClient
  selectedRows: OrgMemberRow[]
  // Members currently visible (the filtered set), for the "N members" label.
  totalCount: number
  allSelected: boolean
  someSelected: boolean
  onToggleSelectAll: () => void
  members: GitHubUser[]
  classrooms: BulkClassroomOption[]
  onClearSelection: () => void
  onDone: (input: {
    classroom: string
    action: "add" | "remove"
    // Rows the server actually enrolled (add only), for optimistic cache seeding.
    addedStudents: StudentCsvRow[]
    // Keys of the selection acted on (both actions), so the page can locate the
    // affected members for optimistic cache updates.
    affectedKeys: string[]
  }) => void
}) => {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()

  const [classroom, setClassroom] = useState("")
  const [action, setAction] = useState<"add" | "remove" | null>(null)
  const [phase, setPhase] = useState<Phase>("idle")
  const [progress, setProgress] = useState<Progress>({
    processed: 0,
    total: 0,
    message: "",
  })
  const [result, setResult] = useState<ResultView | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Gates the destructive bulk remove behind a confirmation step.
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  const hasSelection = selectedRows.length > 0

  // The picker starts unset; until the teacher picks one, default to the first
  // classroom. Derived (not synced via an effect) so there's no cascading
  // render, and it stays correct if the classroom list arrives after mount.
  const effectiveClassroom =
    classroom || (classrooms.length > 0 ? classrooms[0].path : "")

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

  const run = async (which: "add" | "remove") => {
    if (!effectiveClassroom || selectedRows.length === 0) return
    setAction(which)
    setPhase("working")
    setError(null)
    setResult(null)
    setProgress({
      processed: 0,
      total: selectedRows.length,
      message: t("orgMembers.bulk.starting"),
    })

    try {
      if (which === "add") {
        const res = await bulkAddToClassroom(client, {
          org,
          classroom: effectiveClassroom,
          rows: selectedRows,
          members,
          onProgress: setProgress,
        })
        setResult(buildAddResult(res, effectiveClassroom, t))
        onDone({
          classroom: effectiveClassroom,
          action: "add",
          addedStudents: res.enroll?.addedStudents ?? [],
          affectedKeys: selectedRows.map((r) => r.key),
        })
      } else {
        const res = await bulkRemoveFromClassroom(client, {
          org,
          classroom: effectiveClassroom,
          rows: selectedRows,
          onProgress: setProgress,
        })
        setResult(buildRemoveResult(res, effectiveClassroom, t))
        onDone({
          classroom: effectiveClassroom,
          action: "remove",
          addedStudents: [],
          affectedKeys: res.outcomes
            .filter((o) => o.status === "removed")
            .map((o) => o.key),
        })
      }
      setPhase("complete")
    } catch (err) {
      console.error(err)
      setError(
        err instanceof Error ? err.message : t("orgMembers.somethingWrong"),
      )
      setPhase("error")
    }
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
            aria-label={t("orgMembers.bulk.selectAll")}
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected && !allSelected
            }}
            onChange={onToggleSelectAll}
          />
          <span className="text-sm font-medium tabular-nums">
            {hasSelection
              ? t("orgMembers.bulk.selectedCount", {
                  count: selectedRows.length,
                })
              : t("orgMembers.bulk.memberCount", { count: totalCount })}
          </span>
        </label>

        {hasSelection ? (
          <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
            <label
              htmlFor={`${titleId}-picker`}
              className="text-sm text-base-content/60"
            >
              {t("orgMembers.bulk.classroomLabel")}
            </label>
            <select
              id={`${titleId}-picker`}
              className="select select-bordered select-sm max-w-[12rem]"
              value={effectiveClassroom}
              onChange={(e) => setClassroom(e.target.value)}
              disabled={classrooms.length === 0}
            >
              {classrooms.length === 0 ? (
                <option value="">{t("orgMembers.bulk.noClassrooms")}</option>
              ) : (
                classrooms.map((c) => (
                  <option key={c.path} value={c.path}>
                    {c.name}
                  </option>
                ))
              )}
            </select>

            <div className="join">
              <button
                type="button"
                className="btn btn-sm btn-primary join-item"
                disabled={!effectiveClassroom}
                aria-label={t("orgMembers.bulk.addToClassroom", {
                  classroom: effectiveClassroom,
                })}
                title={t("orgMembers.bulk.addToClassroom", {
                  classroom: effectiveClassroom,
                })}
                onClick={() => void run("add")}
              >
                <Plus aria-hidden="true" className="size-4" />
                {t("orgMembers.bulk.add")}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost join-item text-error hover:bg-error/10"
                disabled={!effectiveClassroom}
                aria-label={t("orgMembers.bulk.removeFromClassroom", {
                  classroom: effectiveClassroom,
                })}
                title={t("orgMembers.bulk.removeFromClassroom", {
                  classroom: effectiveClassroom,
                })}
                onClick={() => setConfirmingRemove(true)}
              >
                <UserMinus aria-hidden="true" className="size-4" />
                {t("orgMembers.bulk.remove")}
              </button>
            </div>

            <button
              type="button"
              className="btn btn-sm btn-ghost btn-square"
              aria-label={t("orgMembers.bulk.clearSelection")}
              title={t("orgMembers.bulk.clearSelection")}
              onClick={onClearSelection}
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
        ) : null}
      </div>

      <ConfirmModal
        open={confirmingRemove}
        dangerous
        needsConfirm={false}
        title={t("orgMembers.bulk.confirmRemoveTitle", {
          count: selectedRows.length,
          classroom: effectiveClassroom,
        })}
        description={t("orgMembers.bulk.confirmRemoveBody", {
          count: selectedRows.length,
          classroom: effectiveClassroom,
        })}
        confirmLabel={t("orgMembers.bulk.remove")}
        onConfirm={async () => {
          // Close the confirm dialog first, then start the run on the next tick:
          // two open <dialog showModal> at once is invalid (the second throws),
          // so let the confirm dialog's close settle before run() opens the
          // progress/results dialog. Not awaited — run() drives its own dialog.
          setConfirmingRemove(false)
          setTimeout(() => void run("remove"), 0)
        }}
        onClose={() => setConfirmingRemove(false)}
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
              {action === "remove"
                ? t("orgMembers.bulk.removeTitle", {
                    classroom: effectiveClassroom,
                  })
                : t("orgMembers.bulk.addTitle", {
                    classroom: effectiveClassroom,
                  })}
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
                  {t("orgMembers.bulk.progressProcessed", {
                    processed: progress.processed,
                    total: progress.total,
                  })}
                </span>
                <span>{progressPercent}%</span>
              </div>
              <div className="alert mt-6">
                <span>{t("orgMembers.bulk.keepTabOpen")}</span>
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
                  {t("orgMembers.bulk.done")}
                </button>
              </div>
            </div>
          )}

          {phase === "error" && (
            <div className="mt-6">
              <div className="alert alert-error" role="alert">
                <span>{error ?? t("orgMembers.somethingWrong")}</span>
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

export default BulkActionsBar
