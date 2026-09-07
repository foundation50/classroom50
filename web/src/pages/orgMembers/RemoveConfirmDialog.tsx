import { useTranslation } from "react-i18next"

import { AnimatedAlert, Checkbox, FormField, Select } from "@/components/ui"
import { ConfirmModal } from "@/components/modals"
import { canTargetForUnenroll } from "@/util/classroomRoleUI"
import type { OrgMemberRow } from "@/util/orgMembers"
import PreviewPanel from "@/pages/orgMembers/PreviewPanel"
import type { BulkClassroomOption } from "@/pages/orgMembers/BulkActionsBar"

// The destructive remove confirm: classroom picker, the #664 escalation
// checkbox, a preview mirroring the orchestrators' pre-filters, and the
// typed-phrase gate. Pure view — BulkActionsBar owns the state and runs.
const RemoveConfirmDialog = ({
  open,
  org,
  selectedRows,
  classrooms,
  target,
  onTargetChange,
  scope,
  alsoRemoveFromOrg,
  onAlsoRemoveFromOrgChange,
  isOwner,
  onConfirm,
  onClose,
}: {
  open: boolean
  org: string
  selectedRows: OrgMemberRow[]
  // Only classrooms the selection can actually be removed from.
  classrooms: BulkClassroomOption[]
  target: string
  onTargetChange: (path: string) => void
  scope: "classroom" | "org"
  alsoRemoveFromOrg: boolean
  onAlsoRemoveFromOrgChange: (checked: boolean) => void
  isOwner: (row: OrgMemberRow) => boolean
  onConfirm: (which: "remove" | "remove-org") => void
  onClose: () => void
}) => {
  const { t } = useTranslation()

  const targetName = classrooms.find((c) => c.path === target)?.name ?? target
  const removeIsOrgWide = scope === "org" || alsoRemoveFromOrg

  // ---- Previews: mirror each orchestrator's PRE-filters (runtime skips can
  // only shrink the counts; the results view reports those).

  // bulkRemoveFromClassroom: skips rows not on the target, archived
  // instances, and identity-less pending email invites.
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

  // Members the escalation would also pull out of classrooms OTHER than the
  // targeted one — the blast radius to surface before widening the action.
  const otherClassroomsCount = selectedRows.filter((row) =>
    row.classrooms.some((c) => c.classroom !== target && !c.archived),
  ).length

  // Co-owners in the selection: an org-wide removal strips their owner access
  // like anyone else's, which deserves its own signal in a shared org.
  const ownerCount = removeIsOrgWide ? selectedRows.filter(isOwner).length : 0

  return (
    <ConfirmModal
      open={open}
      tone="error"
      warning={
        removeIsOrgWide
          ? t("orgMembers.bulk.confirmRemoveOrgWarning")
          : undefined
      }
      needsConfirm
      confirmText={t("orgMembers.bulk.confirmPhrase")}
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
        onConfirm(removeIsOrgWide ? "remove-org" : "remove")
      }}
      onClose={onClose}
    >
      <div className="mt-6 flex flex-col gap-4">
        {scope === "classroom" ? (
          <>
            {/* Only classrooms the selection actually touches are offered —
                any other target would be a guaranteed all-skip no-op. */}
            <FormField label={t("orgMembers.bulk.classroomLabel")}>
              {({ id }) => (
                <Select
                  id={id}
                  value={target}
                  onChange={(e) => onTargetChange(e.target.value)}
                >
                  {classrooms.map((c) => (
                    <option key={c.path} value={c.path}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            {/* The #664 opt-in (the direct org route IS the escalation, so no
                checkbox there). Ticking it widens the run to the WHOLE
                selection — the label carries the full count to say so. */}
            <label className="flex cursor-pointer items-start gap-3">
              <Checkbox
                tone="error"
                className="mt-0.5"
                checked={alsoRemoveFromOrg}
                onChange={(e) => onAlsoRemoveFromOrgChange(e.target.checked)}
              />
              <span className="text-sm">
                {t("orgMembers.bulk.alsoRemoveFromOrg", {
                  count: selectedRows.length,
                  org,
                })}
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
            scope === "classroom" &&
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
        <AnimatedAlert tone="warning" show={ownerCount > 0} className="text-sm">
          <span>
            {t("orgMembers.bulk.orgRemoveOwners", { count: ownerCount })}
          </span>
        </AnimatedAlert>
      </div>
    </ConfirmModal>
  )
}

export default RemoveConfirmDialog
