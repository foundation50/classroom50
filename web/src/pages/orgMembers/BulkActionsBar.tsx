import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  ChevronDownIcon,
  PlusIcon,
  SignOutIcon,
  XCircleIcon,
  XIcon,
} from "@/components/ui/icons"

import {
  Alert,
  AnimatedAlert,
  Button,
  DropdownMenu,
  FormField,
  Modal,
  Select,
  closeDropdownMenu,
} from "@/components/ui"
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
import { canTargetForUnenroll } from "@/util/classroomRoleUI"
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

// The confirm dialogs' "what will happen" summary: the action line, then one
// muted line per skip bucket.
const PreviewPanel = ({
  primary,
  notes,
}: {
  primary: string
  notes: string[]
}) => (
  <div className="flex flex-col gap-1 rounded-box border border-base-300 bg-base-200/50 p-4 text-sm">
    <span className="font-medium">{primary}</span>
    {notes.map((note) => (
      <span key={note} className="text-base-content/70">
        {note}
      </span>
    ))}
  </div>
)

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

  // The classroom a menu action targets, set when its submenu entry is picked
  // and consumed by that action's confirm + run. `target` is the config-repo
  // path (what the writers key on); `targetName` is the display name the
  // confirm/result copy shows.
  const [target, setTarget] = useState("")
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
  // Gates the destructive bulk remove behind a confirmation step. Scope is
  // what the teacher picked in the menu: a classroom-scoped remove (which the
  // #664 checkbox can escalate) or a direct org removal (no checkbox — the
  // escalation is already the action).
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [removeScope, setRemoveScope] = useState<"classroom" | "org">(
    "classroom",
  )
  // Gates the bulk add (org invite + classroom enroll) behind a confirmation.
  const [confirmingAdd, setConfirmingAdd] = useState(false)
  // The #664 opt-in: escalate the remove from the picked classroom to the
  // whole organization (which unenrolls from EVERY classroom first).
  const [alsoRemoveFromOrg, setAlsoRemoveFromOrg] = useState(false)

  const hasSelection = selectedRows.length > 0

  const targetName = classrooms.find((c) => c.path === target)?.name ?? target

  // ---- Confirm-dialog previews ---------------------------------------------
  // Each mirrors its orchestrator's PRE-filters over the current selection +
  // target, so the numbers shown are the numbers the run would act on (the
  // engines' own runtime skips — stale ids, racing edits — can only shrink
  // them further and are reported in the results view).

  // bulkAddToClassroom: skips rows already on the target (CSV-derived) and
  // rows that aren't live org members (never invites from here).
  const addPreview = (() => {
    let eligible = 0
    let alreadyOn = 0
    let notMember = 0
    for (const row of selectedRows) {
      if (row.classrooms.some((c) => c.classroom === target)) alreadyOn++
      else if (!row.isMember) notMember++
      else eligible++
    }
    return { eligible, alreadyOn, notMember }
  })()

  // bulkRemoveFromClassroom: skips rows not on the target, rows on an
  // archived instance, and identity-less pending email invites.
  const removePreview = (() => {
    let removable = 0
    let notOn = 0
    let archived = 0
    let pendingEmail = 0
    for (const row of selectedRows) {
      const access = row.classrooms.find((c) => c.classroom === target)
      if (!access) notOn++
      else if (access.archived) archived++
      else if (!canTargetForUnenroll(row)) pendingEmail++
      else removable++
    }
    return { removable, notOn, archived, pendingEmail }
  })()

  // bulkRemoveFromOrg: skips username-less rows (the membership DELETE is
  // keyed by username); self is excluded by selection already.
  const orgPreview = (() => {
    let removable = 0
    let noUsername = 0
    for (const row of selectedRows) {
      if (row.username) removable++
      else noUsername++
    }
    return { removable, noUsername }
  })()

  // The confirmed remove runs org-wide when the teacher either picked the
  // direct org action or ticked the escalation checkbox.
  const removeIsOrgWide = removeScope === "org" || alsoRemoveFromOrg

  // Classrooms at least one selected member can actually be removed from —
  // the remove submenu offers only these (a target nobody is on would be a
  // guaranteed all-skip no-op).
  const removableClassrooms = classrooms.filter((c) =>
    selectedRows.some((row) =>
      row.classrooms.some((a) => a.classroom === c.path && !a.archived),
    ),
  )

  // Visibility is its own flag: closing must not reset phase/result/action
  // (close-animation note in ui/Modal); each run resets them anyway.
  const [isOpen, setModalOpen] = useState(false)

  const deferRun = useDeferredRun()

  const closeModal = () => {
    if (phase === "working") return
    setModalOpen(false)
  }

  // Members the escalated org removal would also pull out of classrooms OTHER
  // than the targeted (non-archived) one — the blast radius the confirm
  // dialog must surface before a classroom remove escalates to an org
  // removal. (The direct org action needs no extra warning: its body already
  // says every classroom is unenrolled.)
  const otherClassroomsCount = selectedRows.filter((row) =>
    row.classrooms.some((c) => c.classroom !== target && !c.archived),
  ).length

  const run = async (which: "add" | "remove" | "remove-org") => {
    if (selectedRows.length === 0) return
    if (which !== "remove-org" && !target) return
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
          classroom: target,
          rows: selectedRows,
          members,
          onProgress: setProgress,
        })
        setResult(buildAddResult(res, targetName, t))
        onDone({
          classroom: target,
          action: "add",
          addedStudents: res.enroll?.addedStudents ?? [],
          affectedKeys: selectedRows.map((r) => r.key),
        })
      } else if (which === "remove") {
        const res = await bulkRemoveFromClassroom(client, {
          org,
          classroom: target,
          rows: selectedRows,
          onProgress: setProgress,
        })
        setResult(buildRemoveResult(res, targetName, t))
        onDone({
          classroom: target,
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
          while rows are selected: count, one consolidated Actions menu, and
          Clear — mirroring the roster toolbar's cluster. The destination
          classroom is folded INTO the menu as submenus (pick the action and
          its target in one gesture — no separate picker), with the
          destructive actions last in their own group. The modals below stay
          mounted regardless, so a completing run's result dialog survives
          the selection clearing out from under it. */}
      {hasSelection ? (
        <>
          <span className="text-sm font-medium tabular-nums">
            {t("orgMembers.bulk.selectedCount", {
              count: selectedRows.length,
            })}
          </span>
          {/* dropdown-start: the cluster sits on the toolbar's left, so the
              menu opens rightward instead of off the edge. */}
          <div className="dropdown dropdown-start">
            <Button variant="primary" size="sm">
              {t("orgMembers.bulk.actions")}
              <ChevronDownIcon aria-hidden="true" className="size-4" />
            </Button>
            <DropdownMenu className="w-64">
              <li>
                <button
                  type="button"
                  disabled={classrooms.length === 0}
                  title={
                    classrooms.length === 0
                      ? t("orgMembers.bulk.noClassrooms")
                      : undefined
                  }
                  onClick={() => {
                    closeDropdownMenu()
                    if (classrooms.length === 0) return
                    setTarget(classrooms[0].path)
                    setConfirmingAdd(true)
                  }}
                >
                  <PlusIcon aria-hidden="true" className="size-4" />
                  {t("orgMembers.bulk.addToClassroomMenu")}
                </button>
              </li>
              {/* Removals — destructive, so last and in their own group. */}
              <DropdownMenu.Separator />
              <li>
                <button
                  type="button"
                  className="text-error"
                  disabled={removableClassrooms.length === 0}
                  title={
                    removableClassrooms.length === 0
                      ? t("orgMembers.bulk.removeNoneOnClassroom")
                      : undefined
                  }
                  onClick={() => {
                    closeDropdownMenu()
                    if (removableClassrooms.length === 0) return
                    setTarget(removableClassrooms[0].path)
                    setRemoveScope("classroom")
                    // Fresh decision each time: the escalation is opt-in per
                    // run.
                    setAlsoRemoveFromOrg(false)
                    setConfirmingRemove(true)
                  }}
                >
                  <SignOutIcon aria-hidden="true" className="size-4" />
                  {t("orgMembers.bulk.removeFromClassroomMenu")}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className="text-error"
                  onClick={() => {
                    closeDropdownMenu()
                    setRemoveScope("org")
                    setAlsoRemoveFromOrg(false)
                    setConfirmingRemove(true)
                  }}
                >
                  <XCircleIcon aria-hidden="true" className="size-4" />
                  {t("orgMembers.removeFromOrg")}
                </button>
              </li>
            </DropdownMenu>
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
        needsConfirm
        confirmText="confirm"
        title={
          removeIsOrgWide
            ? t("orgMembers.bulk.confirmRemoveOrgTitle", {
                count: selectedRows.length,
                org,
              })
            : t("orgMembers.bulk.removeModalTitle", {
                count: selectedRows.length,
              })
        }
        description={
          removeIsOrgWide
            ? t("orgMembers.bulk.confirmRemoveOrgBody", {
                count: selectedRows.length,
                org,
              })
            : t("orgMembers.bulk.confirmRemoveBody", {
                count: selectedRows.length,
                classroom: targetName,
              })
        }
        confirmLabel={
          removeIsOrgWide
            ? t("orgMembers.removeFromOrg")
            : t("orgMembers.bulk.remove")
        }
        confirmDisabled={
          removeIsOrgWide
            ? orgPreview.removable === 0
            : removePreview.removable === 0
        }
        onConfirm={async () => {
          // Close the confirm dialog first, then start the run next tick, so
          // the progress dialog doesn't stack its box and backdrop over the
          // still-closing confirm. Not awaited — run() drives its own dialog.
          const which = removeIsOrgWide ? "remove-org" : "remove"
          setConfirmingRemove(false)
          deferRun(() => run(which))
        }}
        onClose={() => setConfirmingRemove(false)}
      >
        <div className="mt-6 flex flex-col gap-4">
          {removeScope === "classroom" ? (
            <>
              {/* Only classrooms the selection actually touches are offered —
                  any other target would be a guaranteed all-skip no-op. */}
              <FormField label={t("orgMembers.bulk.classroomLabel")}>
                {({ id }) => (
                  <Select
                    id={id}
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    {removableClassrooms.map((c) => (
                      <option key={c.path} value={c.path}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
              {/* The #664 opt-in, offered only on the classroom-scoped route
                  (the direct org action IS the escalation). Ticking it
                  escalates this run to an org removal, so the copy and the
                  preview re-derive from the checkbox state. */}
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
            </>
          ) : null}
          {removeIsOrgWide ? (
            <PreviewPanel
              primary={t("orgMembers.bulk.previewRemoveOrg", {
                count: orgPreview.removable,
                org,
              })}
              notes={
                orgPreview.noUsername > 0
                  ? [
                      t("orgMembers.bulk.previewSkipNoUsername", {
                        count: orgPreview.noUsername,
                      }),
                    ]
                  : []
              }
            />
          ) : (
            <PreviewPanel
              primary={t("orgMembers.bulk.previewRemove", {
                count: removePreview.removable,
                classroom: targetName,
              })}
              notes={[
                ...(removePreview.notOn > 0
                  ? [
                      t("orgMembers.bulk.previewSkipNotOn", {
                        count: removePreview.notOn,
                      }),
                    ]
                  : []),
                ...(removePreview.archived > 0
                  ? [
                      t("orgMembers.bulk.previewSkipArchived", {
                        count: removePreview.archived,
                      }),
                    ]
                  : []),
                ...(removePreview.pendingEmail > 0
                  ? [
                      t("orgMembers.bulk.previewSkipPendingEmail", {
                        count: removePreview.pendingEmail,
                      }),
                    ]
                  : []),
              ]}
            />
          )}
          <AnimatedAlert
            tone="warning"
            show={
              removeScope === "classroom" &&
              alsoRemoveFromOrg &&
              otherClassroomsCount > 0
            }
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
        title={t("orgMembers.bulk.addModalTitle", {
          count: selectedRows.length,
        })}
        description={t("orgMembers.bulk.confirmAddBody", {
          count: selectedRows.length,
          classroom: targetName,
        })}
        confirmLabel={t("orgMembers.bulk.add")}
        confirmDisabled={addPreview.eligible === 0}
        onConfirm={async () => {
          setConfirmingAdd(false)
          deferRun(() => run("add"))
        }}
        onClose={() => setConfirmingAdd(false)}
      >
        <div className="mt-6 flex flex-col gap-4">
          <FormField label={t("orgMembers.bulk.destinationLabel")}>
            {({ id }) => (
              <Select
                id={id}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                {classrooms.map((c) => (
                  <option key={c.path} value={c.path}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <PreviewPanel
            primary={t("orgMembers.bulk.previewAdd", {
              count: addPreview.eligible,
              classroom: targetName,
            })}
            notes={[
              ...(addPreview.alreadyOn > 0
                ? [
                    t("orgMembers.bulk.previewSkipAlreadyOn", {
                      count: addPreview.alreadyOn,
                    }),
                  ]
                : []),
              ...(addPreview.notMember > 0
                ? [
                    t("orgMembers.bulk.previewSkipNotMember", {
                      count: addPreview.notMember,
                    }),
                  ]
                : []),
            ]}
          />
        </div>
      </ConfirmModal>

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
                  classroom: targetName,
                })
              : t("orgMembers.bulk.addTitle", {
                  classroom: targetName,
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
