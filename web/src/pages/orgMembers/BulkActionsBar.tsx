import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { PlusIcon, XIcon } from "@/components/ui/icons"

import { Alert, AnimatedAlert, Button, Modal, Select } from "@/components/ui"
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
import {
  bulkRemoveFromOrg,
  type BulkRemoveFromOrgResult,
} from "@/domain/orgMembers/bulkRemoveFromOrg"
import { ConfirmModal } from "@/components/modals"
import { useDeferredRun } from "@/hooks/useDeferredRun"
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

const buildOrgRemoveResult = (
  res: BulkRemoveFromOrgResult,
  org: string,
  t: ReturnType<typeof useTranslation>["t"],
): BulkResultView => {
  const removed = res.outcomes.filter((o) => o.status === "removed")
  const skipped = res.outcomes.filter((o) => o.status === "skipped")
  const failed = res.outcomes.filter((o) => o.status === "failed")
  const sections: BulkResultView["sections"] = []
  // Removed rows are listed (unlike the classroom-scoped remove) because each
  // carries its own blast radius: how many classrooms the removal unenrolled.
  if (removed.length > 0) {
    sections.push({
      title: t("orgMembers.bulk.resultRemoved"),
      rows: removed.map((o) => ({
        key: o.key,
        label: o.label,
        detail:
          o.unenrolledClassrooms.length > 0
            ? t("orgMembers.bulk.unenrolledDetail", {
                count: o.unenrolledClassrooms.length,
                classrooms: o.unenrolledClassrooms.join(", "),
              })
            : undefined,
      })),
    })
  }
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
    headline: t("orgMembers.bulk.removedFromOrgHeadline", {
      count: removed.length,
      org,
    }),
    sections,
  }
}

// What a completed bulk run changed, so the page can seed/invalidate exactly
// the caches that action touched.
export type BulkDoneInput =
  | {
      action: "add"
      classroom: string
      // Rows the server actually enrolled, for optimistic seeding.
      addedStudents: StudentCsvRow[]
      affectedKeys: string[]
    }
  | { action: "remove"; classroom: string; affectedKeys: string[] }
  // Org-wide removal: affectedKeys are the CONFIRMED-removed rows; every
  // classroom they belonged to is affected, not just the picked one.
  | { action: "remove-org"; affectedKeys: string[] }

// The members toolbar's selection cluster (count + classroom picker +
// Add/Remove + Clear), shown only while rows are selected — mirroring the
// roster toolbar's cluster. Owns its run modal (progress -> results) and
// drives the bulk orchestrators. The Remove confirm carries the "also remove
// from the organization" opt-in (#664), which escalates the run from a
// classroom-scoped unenroll to a full org removal. On success it calls onDone
// so the page can optimistically seed caches.
const BulkActionsBar = ({
  org,
  client,
  selectedRows,
  members,
  classrooms,
  onClearSelection,
  onDone,
}: {
  org: string
  client: GitHubClient
  selectedRows: OrgMemberRow[]
  members: GitHubUser[]
  classrooms: BulkClassroomOption[]
  onClearSelection: () => void
  onDone: (input: BulkDoneInput) => void
}) => {
  const { t } = useTranslation()
  const pickerId = useId()

  const [classroom, setClassroom] = useState("")
  const [action, setAction] = useState<"add" | "remove" | "remove-org" | null>(
    null,
  )
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
  // The #664 opt-in: escalate the remove from the picked classroom to the
  // whole organization (which unenrolls from EVERY classroom first).
  const [alsoRemoveFromOrg, setAlsoRemoveFromOrg] = useState(false)

  const hasSelection = selectedRows.length > 0

  // Picker starts unset; until the teacher picks one, default to the first
  // classroom. Derived (not effect-synced) so there's no cascading render, and
  // it stays correct if the classroom list arrives after mount.
  const effectiveClassroom =
    classroom || (classrooms.length > 0 ? classrooms[0].path : "")

  // Visibility is its own flag: closing must not reset phase/result/action
  // (close-animation note in ui/Modal); each run resets them anyway.
  const [isOpen, setModalOpen] = useState(false)

  const deferRun = useDeferredRun()

  const closeModal = () => {
    if (phase === "working") return
    setModalOpen(false)
  }

  // Members the org removal would also pull out of OTHER (non-archived)
  // classrooms — the blast radius the confirm dialog must surface before the
  // teacher escalates a classroom remove to an org removal.
  const otherClassroomsCount = selectedRows.filter((row) =>
    row.classrooms.some(
      (c) => c.classroom !== effectiveClassroom && !c.archived,
    ),
  ).length

  const run = async (which: "add" | "remove" | "remove-org") => {
    if (selectedRows.length === 0) return
    if (which !== "remove-org" && !effectiveClassroom) return
    setAction(which)
    setPhase("working")
    setModalOpen(true)
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
      } else if (which === "remove") {
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
          affectedKeys: res.outcomes
            .filter((o) => o.status === "removed")
            .map((o) => o.key),
        })
      } else {
        const res = await bulkRemoveFromOrg(
          client,
          { org, rows: selectedRows, onProgress: setProgress },
          t,
        )
        setResult(buildOrgRemoveResult(res, org, t))
        onDone({
          action: "remove-org",
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
      {/* The selection cluster lives in the page toolbar and appears only
          while rows are selected: count, classroom picker, Add/Remove, and
          Clear — mirroring the roster toolbar's cluster. The modals below
          stay mounted regardless, so a completing run's result dialog
          survives the selection clearing out from under it. */}
      {hasSelection ? (
        <>
          <span className="text-sm font-medium tabular-nums">
            {t("orgMembers.bulk.selectedCount", {
              count: selectedRows.length,
            })}
          </span>
          <label
            htmlFor={`${pickerId}-picker`}
            className="text-sm text-base-content/60"
          >
            {t("orgMembers.bulk.classroomLabel")}
          </label>
          <Select
            id={`${pickerId}-picker`}
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
              <PlusIcon aria-hidden="true" className="size-4" />
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
              onClick={() => {
                // Fresh decision each time: the escalation is opt-in per run.
                setAlsoRemoveFromOrg(false)
                setConfirmingRemove(true)
              }}
            >
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
            <XIcon aria-hidden="true" className="size-4" />
          </Button>
        </>
      ) : null}

      <ConfirmModal
        open={confirmingRemove}
        dangerous
        needsConfirm={false}
        title={
          alsoRemoveFromOrg
            ? t("orgMembers.bulk.confirmRemoveOrgTitle", {
                count: selectedRows.length,
                org,
              })
            : t("orgMembers.bulk.confirmRemoveTitle", {
                count: selectedRows.length,
                classroom: effectiveClassroom,
              })
        }
        description={
          alsoRemoveFromOrg
            ? t("orgMembers.bulk.confirmRemoveOrgBody", {
                count: selectedRows.length,
                org,
              })
            : t("orgMembers.bulk.confirmRemoveBody", {
                count: selectedRows.length,
                classroom: effectiveClassroom,
              })
        }
        confirmLabel={
          alsoRemoveFromOrg
            ? t("orgMembers.removeFromOrg")
            : t("orgMembers.bulk.remove")
        }
        onConfirm={async () => {
          // Close the confirm dialog first, then start the run next tick, so
          // the progress dialog doesn't stack its box and backdrop over the
          // still-closing confirm. Not awaited — run() drives its own dialog.
          const which = alsoRemoveFromOrg ? "remove-org" : "remove"
          setConfirmingRemove(false)
          deferRun(() => run(which))
        }}
        onClose={() => setConfirmingRemove(false)}
      >
        {/* The #664 opt-in. Ticking it escalates this run from a
            classroom-scoped unenroll to an org removal, so the copy above and
            the warning below re-derive from the checkbox state. */}
        <div className="mt-6 flex flex-col gap-3">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="checkbox checkbox-sm checkbox-error mt-0.5"
              checked={alsoRemoveFromOrg}
              onChange={(e) => setAlsoRemoveFromOrg(e.target.checked)}
            />
            <span className="text-sm">
              {t("orgMembers.bulk.alsoRemoveFromOrg", { org })}
            </span>
          </label>
          <AnimatedAlert
            tone="warning"
            show={alsoRemoveFromOrg && otherClassroomsCount > 0}
            className="text-sm"
          >
            <span>
              {t("orgMembers.bulk.orgRemoveOtherClassrooms", {
                count: otherClassroomsCount,
              })}
            </span>
          </AnimatedAlert>
        </div>
      </ConfirmModal>

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
          deferRun(() => run("add"))
        }}
        onClose={() => setConfirmingAdd(false)}
      />

      <Modal
        open={isOpen}
        onClose={closeModal}
        closeDisabled={phase === "working"}
        size="2xl"
        title={
          action === "remove-org"
            ? t("orgMembers.bulk.removeOrgTitle", { org })
            : action === "remove"
              ? t("orgMembers.bulk.removeTitle", {
                  classroom: effectiveClassroom,
                })
              : t("orgMembers.bulk.addTitle", {
                  classroom: effectiveClassroom,
                })
        }
        footer={
          phase === "complete" ? (
            <Button variant="primary" onClick={closeModal}>
              {t("orgMembers.bulk.done")}
            </Button>
          ) : phase === "error" ? (
            <Button variant="primary" onClick={closeModal}>
              {t("common.done")}
            </Button>
          ) : undefined
        }
      >
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
          </div>
        )}

        {phase === "error" && (
          <div className="mt-6">
            <Alert tone="error">
              <span>{error ?? t("orgMembers.somethingWrong")}</span>
            </Alert>
          </div>
        )}
      </Modal>
    </>
  )
}

export default BulkActionsBar
