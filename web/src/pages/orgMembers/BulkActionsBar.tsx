import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { Plus, UserMinus, X } from "lucide-react"

import { Alert, Button, Modal, Select, Toolbar } from "@/components/ui"
import type { GitHubClient } from "@/github-core/client"
import type { GitHubUser } from "@/github-core/types"
import type { StudentCsvRow } from "@/domain/students"
import type { OrgMemberRow } from "@/util/orgMembers"
import {
  bulkAddToClassroom,
  type BulkAddToClassroomResult,
} from "@/domain/orgMembers/bulkAddToClassroom"
import {
  bulkRemoveFromClassroom,
  type BulkRemoveFromClassroomResult,
} from "@/domain/orgMembers/bulkRemoveFromClassroom"
import { ConfirmModal } from "@/components/modals"
import { logger } from "@/lib/logger"
import {
  BulkResultSection,
  type BulkPhase,
  type BulkProgress,
  type BulkResultView,
} from "@/components/bulk/resultView"

const log = logger.scope("orgMembers:BulkActionsBar")

// A classroom option for the picker (the config-repo dir name/path).
export type BulkClassroomOption = { name: string; path: string }

const buildAddResult = (
  res: BulkAddToClassroomResult,
  classroom: string,
  t: ReturnType<typeof useTranslation>["t"],
): BulkResultView => {
  const added = res.enroll?.addedStudents ?? []
  const csvSkipped = res.enroll?.skippedStudents ?? []
  const teamFailed = (res.enroll?.teamResults ?? []).filter(
    (r) => r.status === "failed",
  )
  const sections: BulkResultView["sections"] = []
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
): BulkResultView => {
  const removed = res.outcomes.filter((o) => o.status === "removed")
  const skipped = res.outcomes.filter((o) => o.status === "skipped")
  const failed = res.outcomes.filter((o) => o.status === "failed")
  const sections: BulkResultView["sections"] = []
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
  // Non-fatal side-effect warnings (team drop / invite cancel) — roster removal
  // itself succeeded, so these are informational.
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

// The members table's header toolbar: always shows select-all + a contextual
// label; once rows are selected it reveals the classroom picker +
// Add/Remove/Clear inline (no floating bar, no layout shift — only the right
// side fills in). Owns its run modal (progress -> results) and drives the bulk
// orchestrators. On success it calls onDone with the enrolled rows so the page
// can optimistically seed caches.
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
    // Rows the server actually enrolled (add only), for optimistic seeding.
    addedStudents: StudentCsvRow[]
    // Keys of the selection acted on (both actions), so the page can locate the
    // affected members for cache updates.
    affectedKeys: string[]
  }) => void
}) => {
  const { t } = useTranslation()
  const titleId = useId()

  const [classroom, setClassroom] = useState("")
  const [action, setAction] = useState<"add" | "remove" | null>(null)
  const [phase, setPhase] = useState<BulkPhase>("idle")
  const [progress, setProgress] = useState<BulkProgress>({
    processed: 0,
    total: 0,
    message: "",
  })
  const [result, setResult] = useState<BulkResultView | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Gates the destructive bulk remove behind a confirmation step.
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  // Gates the bulk add (org invite + classroom enroll) behind a confirmation.
  const [confirmingAdd, setConfirmingAdd] = useState(false)

  const hasSelection = selectedRows.length > 0

  // Picker starts unset; until the teacher picks one, default to the first
  // classroom. Derived (not effect-synced) so there's no cascading render, and
  // it stays correct if the classroom list arrives after mount.
  const effectiveClassroom =
    classroom || (classrooms.length > 0 ? classrooms[0].path : "")

  const isOpen = phase !== "idle"

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
      log.error("bulk action failed", { err, record: true })
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
      <Toolbar
        header
        className={`transition-colors ${hasSelection ? "bg-base-200/60" : ""}`}
      >
        <Toolbar.Selection
          allSelected={allSelected}
          someSelected={someSelected}
          onToggleSelectAll={onToggleSelectAll}
          selectAllAriaLabel={t("orgMembers.bulk.selectAll")}
          label={
            hasSelection
              ? t("orgMembers.bulk.selectedCount", {
                  count: selectedRows.length,
                })
              : t("orgMembers.bulk.memberCount", { count: totalCount })
          }
        >
          {hasSelection ? (
            <>
              <label
                htmlFor={`${titleId}-picker`}
                className="text-sm text-base-content/60"
              >
                {t("orgMembers.bulk.classroomLabel")}
              </label>
              <Select
                id={`${titleId}-picker`}
                selectSize="sm"
                className="max-w-[12rem] w-auto"
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
              </Select>

              <div className="join">
                <Button
                  variant="primary"
                  size="sm"
                  className="join-item"
                  disabled={!effectiveClassroom}
                  aria-label={t("orgMembers.bulk.addToClassroom", {
                    classroom: effectiveClassroom,
                  })}
                  title={t("orgMembers.bulk.addToClassroom", {
                    classroom: effectiveClassroom,
                  })}
                  onClick={() => setConfirmingAdd(true)}
                >
                  <Plus aria-hidden="true" className="size-4" />
                  {t("orgMembers.bulk.add")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="join-item text-error hover:bg-error/10"
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
                </Button>
              </div>

              <Button
                variant="ghost"
                size="sm"
                shape="square"
                aria-label={t("orgMembers.bulk.clearSelection")}
                title={t("orgMembers.bulk.clearSelection")}
                onClick={onClearSelection}
              >
                <X aria-hidden="true" className="size-4" />
              </Button>
            </>
          ) : null}
        </Toolbar.Selection>
      </Toolbar>

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
          // Close the confirm dialog first, then start the run next tick: two
          // open <dialog showModal> at once is invalid (the second throws), so
          // let the confirm close settle before run() opens the progress dialog.
          // Not awaited — run() drives its own dialog.
          setConfirmingRemove(false)
          setTimeout(() => void run("remove"), 0)
        }}
        onClose={() => setConfirmingRemove(false)}
      />

      <ConfirmModal
        open={confirmingAdd}
        dangerous={false}
        needsConfirm={false}
        title={t("orgMembers.bulk.confirmAddTitle", {
          count: selectedRows.length,
          classroom: effectiveClassroom,
        })}
        description={t("orgMembers.bulk.confirmAddBody", {
          count: selectedRows.length,
          classroom: effectiveClassroom,
        })}
        confirmLabel={t("orgMembers.bulk.add")}
        onConfirm={async () => {
          setConfirmingAdd(false)
          setTimeout(() => void run("add"), 0)
        }}
        onClose={() => setConfirmingAdd(false)}
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
            {action === "remove"
              ? t("orgMembers.bulk.removeTitle", {
                  classroom: effectiveClassroom,
                })
              : t("orgMembers.bulk.addTitle", {
                  classroom: effectiveClassroom,
                })}
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
                {t("orgMembers.bulk.progressProcessed", {
                  processed: progress.processed,
                  total: progress.total,
                })}
              </span>
              <span>{progressPercent}%</span>
            </div>
            <Alert tone="info" className="mt-6">
              <span>{t("orgMembers.bulk.keepTabOpen")}</span>
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
                {t("orgMembers.bulk.done")}
              </Button>
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="mt-6">
            <Alert tone="error">
              <span>{error ?? t("orgMembers.somethingWrong")}</span>
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

export default BulkActionsBar
