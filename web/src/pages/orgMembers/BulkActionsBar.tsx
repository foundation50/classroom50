import { useState } from "react"
import { useTranslation } from "react-i18next"
import { PlusIcon, SignOutIcon, XCircleIcon } from "@/components/ui/icons"

import { DropdownMenu, FormField, Select } from "@/components/ui"
import { BulkSelectionCluster } from "@/components/bulk/BulkSelectionCluster"
import type { GitHubUser } from "@/github-core/types"
import type { OrgMemberRow } from "@/util/orgMembers"
import { canTargetForUnenroll } from "@/util/classroomRoleUI"
import type { OrgMembersBulkOutcome } from "@/hooks/useOrgMembersCacheSync"
import { useBulkAddToClassroom } from "@/hooks/mutations/useBulkAddToClassroom"
import { useBulkRemoveFromClassroom } from "@/hooks/mutations/useBulkRemoveFromClassroom"
import { useBulkRemoveFromOrg } from "@/hooks/mutations/useBulkRemoveFromOrg"
import { ConfirmModal } from "@/components/modals"
import { useDeferredRun } from "@/hooks/useDeferredRun"
import { logger } from "@/lib/logger"
import { BulkRunModal, type BulkResultView } from "@/components/bulk/resultView"
import { useBulkRun } from "@/components/bulk/useBulkRun"
import {
  buildAddResult,
  buildOrgRemoveResult,
  buildRemoveResult,
} from "@/pages/orgMembers/bulkResults"
import PreviewPanel from "@/pages/orgMembers/PreviewPanel"
import RemoveConfirmDialog from "@/pages/orgMembers/RemoveConfirmDialog"
import { errorText } from "@/types/localizedMessage"

const log = logger.scope("orgMembers:BulkActionsBar")

// A classroom option for the picker (the config-repo dir name/path).
export type BulkClassroomOption = { name: string; path: string }

// What a completed bulk run changed; the page hands it to
// useOrgMembersCacheSync, which owns the shape.
export type BulkDoneInput = OrgMembersBulkOutcome

// The members toolbar's selection cluster (count + Actions menu + Clear, the
// roster recipe), shown only while rows are selected. Owns the confirm/run
// modals and the #664 escalation state; onDone hands the outcome to the page
// for cache seeding.
const BulkActionsBar = ({
  org,
  selectedRows,
  members,
  classrooms,
  isOwner,
  onClearSelection,
  onRetainSelection,
  onDone,
}: {
  org: string
  selectedRows: OrgMemberRow[]
  members: GitHubUser[]
  classrooms: BulkClassroomOption[]
  // Org owner/admin predicate from the page's admins read — the remove dialog
  // warns when the selection would strip co-owners.
  isOwner: (row: OrgMemberRow) => boolean
  onClearSelection: () => void
  // Narrow the page's selection to these row keys (the roster bar's recipe):
  // each action keeps only the rows it can act on before confirming, so the
  // dialog's count and the ticked checkboxes agree, and a cancelled confirm
  // leaves that narrowed selection in place.
  onRetainSelection: (keys: Iterable<string>) => void
  onDone: (input: BulkDoneInput) => void
}) => {
  const { t } = useTranslation()
  const bulkAdd = useBulkAddToClassroom(org)
  const bulkRemove = useBulkRemoveFromClassroom(org)
  const bulkRemoveOrg = useBulkRemoveFromOrg(org)

  // The classroom a menu action targets: `target` is the config-repo path
  // (what the writers key on); `targetName` the display name copy shows.
  const [target, setTarget] = useState("")
  const [action, setAction] = useState<"add" | "remove" | "remove-org" | null>(
    null,
  )
  const bulk = useBulkRun()
  const { progress } = bulk
  // Gates the destructive remove behind a confirmation. Scope is the menu
  // route: classroom-scoped (which the #664 checkbox can escalate) or the
  // direct org removal (no checkbox — the escalation IS the action).
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [removeScope, setRemoveScope] = useState<"classroom" | "org">(
    "classroom",
  )
  // Gates the bulk add (org invite + classroom enroll) behind a confirmation.
  const [confirmingAdd, setConfirmingAdd] = useState(false)
  // The #664 opt-in: escalate the remove from the picked classroom to the
  // whole organization.
  const [alsoRemoveFromOrg, setAlsoRemoveFromOrg] = useState(false)

  const hasSelection = selectedRows.length > 0

  const targetName = classrooms.find((c) => c.path === target)?.name ?? target

  // Per-action eligibility that does not depend on the classroom picked in the
  // dialog (that part stays in each preview): only members can be added; only
  // an identity-bearing row on some active classroom can be removed from one;
  // only a member with a username can be removed from the org (the DELETE is
  // keyed by username).
  const addableRows = selectedRows.filter((row) => row.isMember)
  const classroomRemovableRows = selectedRows.filter(
    (row) =>
      canTargetForUnenroll(row) && row.classrooms.some((a) => !a.archived),
  )
  const orgRemovableRows = selectedRows.filter(
    (row) => row.isMember && Boolean(row.username),
  )
  const withCount = (label: string, count: number) =>
    t("common.actionWithCount", { label, count })
  const beginAction = (eligible: OrgMemberRow[], open: () => void) => {
    onRetainSelection(eligible.map((r) => r.key))
    open()
  }

  // Add preview, mirroring bulkAddToClassroom's PRE-filters (runtime skips
  // can only shrink it; results report those). Remove previews live in
  // RemoveConfirmDialog.
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

  // Classrooms at least one selected member can actually be removed from —
  // any other target would be a guaranteed all-skip no-op.
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
    if (bulk.busy) return
    setModalOpen(false)
  }

  const run = async (which: "add" | "remove" | "remove-org") => {
    if (selectedRows.length === 0) return
    if (which !== "remove-org" && !target) return
    if (!bulk.begin(selectedRows.length, t("orgMembers.bulk.starting"))) return
    setAction(which)
    setModalOpen(true)

    try {
      let result: BulkResultView
      if (which === "add") {
        const res = await bulkAdd.mutateAsync({
          classroom: target,
          rows: selectedRows,
          members,
          onProgress: bulk.setProgress,
        })
        result = buildAddResult(res, targetName, t)
        onDone({
          classroom: target,
          action: "add",
          addedStudents: res.enroll?.addedStudents ?? [],
          affectedKeys: selectedRows.map((r) => r.key),
        })
      } else if (which === "remove") {
        const res = await bulkRemove.mutateAsync({
          classroom: target,
          rows: selectedRows,
          onProgress: bulk.setProgress,
        })
        result = buildRemoveResult(res, targetName, t)
        onDone({
          classroom: target,
          action: "remove",
          affectedKeys: res.outcomes
            .filter((o) => o.status === "removed")
            .map((o) => o.key),
        })
      } else {
        const res = await bulkRemoveOrg.mutateAsync({
          rows: selectedRows,
          onProgress: bulk.setProgress,
        })
        result = buildOrgRemoveResult(res, org, t)
        onDone({
          action: "remove-org",
          affectedKeys: res.outcomes
            .filter((o) => o.status === "removed")
            .map((o) => o.key),
          unenrolled: res.outcomes
            .filter((o) => o.unenrolledClassrooms.length > 0)
            .map((o) => ({ key: o.key, classrooms: o.unenrolledClassrooms })),
        })
      }
      bulk.complete(result, "complete")
    } catch (err) {
      log.error("bulk action failed", { err, record: true })
      bulk.fail(errorText(t, err))
    }
  }

  return (
    <>
      {/* The selection cluster, shown only while rows are selected. The
          modals below stay mounted regardless, so a completing run's result
          dialog survives the selection clearing out from under it. */}
      {hasSelection ? (
        <BulkSelectionCluster
          countLabel={t("orgMembers.bulk.selectedCount", {
            count: selectedRows.length,
          })}
          onClearSelection={onClearSelection}
        >
          <DropdownMenu.Item
            icon={PlusIcon}
            label={withCount(
              t("orgMembers.bulk.addToClassroomMenu"),
              addableRows.length,
            )}
            disabled={classrooms.length === 0 || addableRows.length === 0}
            title={
              classrooms.length === 0
                ? t("orgMembers.bulk.noClassrooms")
                : addableRows.length === 0
                  ? t("orgMembers.bulk.addNoneMembers")
                  : undefined
            }
            onSelect={() =>
              beginAction(addableRows, () => {
                setTarget(classrooms[0].path)
                setConfirmingAdd(true)
              })
            }
          />
          {/* Removals — destructive, so last and in their own group. */}
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            icon={SignOutIcon}
            label={withCount(
              t("orgMembers.bulk.removeFromClassroomMenu"),
              classroomRemovableRows.length,
            )}
            destructive
            disabled={
              removableClassrooms.length === 0 ||
              classroomRemovableRows.length === 0
            }
            title={
              removableClassrooms.length === 0 ||
              classroomRemovableRows.length === 0
                ? t("orgMembers.bulk.removeNoneOnClassroom")
                : undefined
            }
            onSelect={() =>
              beginAction(classroomRemovableRows, () => {
                setTarget(removableClassrooms[0].path)
                setRemoveScope("classroom")
                // Fresh decision each time: the escalation is opt-in per run.
                setAlsoRemoveFromOrg(false)
                setConfirmingRemove(true)
              })
            }
          />
          <DropdownMenu.Item
            icon={XCircleIcon}
            label={withCount(
              t("orgMembers.removeFromOrg"),
              orgRemovableRows.length,
            )}
            destructive
            disabled={orgRemovableRows.length === 0}
            title={
              orgRemovableRows.length === 0
                ? t("orgMembers.bulk.removeOrgNoneEligible")
                : undefined
            }
            onSelect={() =>
              beginAction(orgRemovableRows, () => {
                setRemoveScope("org")
                setAlsoRemoveFromOrg(false)
                setConfirmingRemove(true)
              })
            }
          />
        </BulkSelectionCluster>
      ) : null}

      <RemoveConfirmDialog
        open={confirmingRemove}
        org={org}
        selectedRows={selectedRows}
        classrooms={removableClassrooms}
        target={target}
        onTargetChange={setTarget}
        scope={removeScope}
        alsoRemoveFromOrg={alsoRemoveFromOrg}
        onAlsoRemoveFromOrgChange={setAlsoRemoveFromOrg}
        isOwner={isOwner}
        onConfirm={(which) => {
          // Close the confirm dialog first, then start the run next tick, so
          // the progress dialog doesn't stack its box and backdrop over the
          // still-closing confirm. Not awaited — run() drives its own dialog.
          setConfirmingRemove(false)
          deferRun(() => run(which))
        }}
        onClose={() => setConfirmingRemove(false)}
      />

      <ConfirmModal
        open={confirmingAdd}
        tone="warning"
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

      <BulkRunModal
        open={isOpen}
        onClose={closeModal}
        run={bulk}
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
        processedCaption={t("orgMembers.bulk.progressProcessed", {
          processed: progress.processed,
          total: progress.total,
        })}
        keepTabOpenMessage={t("orgMembers.bulk.keepTabOpen")}
        fallbackError={t("orgMembers.somethingWrong")}
        doneLabel={t("orgMembers.bulk.done")}
      />
    </>
  )
}

export default BulkActionsBar
