import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { EyeIcon, LockIcon, PencilIcon } from "@/components/ui/icons"

import { Badge, Heading, Modal, MonoLtr } from "@/components/ui"
import { ActionListRow } from "@/pages/submissions/actionLayout"
import {
  assignmentName,
  CloneSubmissionsAction,
  CopyAcceptLinkAction,
  DeleteAssignmentAction,
  LockAssignmentAction,
  ReuseAssignmentAction,
  TemplateAccessAction,
} from "@/pages/assignments/AssignmentRowActions"
import type { Assignment } from "@/types/classroom"

// The assignment hub: the assignments table's counterpart of the submission
// hub (ManageSubmissionModal) — one Manage entry point per row gathering every
// per-assignment action as a labeled list row, so the table keeps only a few
// quick-access shortcuts. Rich sub-modals (clone CLI, template access, reuse)
// stack on the hub via native <dialog> nesting and hide its box while up
// (`subModalOpen`); the small lock/delete confirms stack visibly, like the
// submission hub's regrade confirm.
//
// Mounted only while a row is selected (the caller gates + remounts via `key`),
// so it opens once on mount; Esc/backdrop/X fire onClose to clear the selection.
export const ManageAssignmentModal = ({
  onClose,
  org,
  classroom,
  assignment,
  secret,
  secretPending,
  canMutate,
  onDeleteAssignment,
}: {
  onClose: () => void
  org: string
  classroom: string
  assignment: Assignment
  secret?: string
  secretPending?: boolean
  // Author on an unarchived classroom: gates the mutating rows (edit label,
  // reuse, lock, delete), same tier as the table's quick actions.
  canMutate: boolean
  onDeleteAssignment: () => void
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [subModalOpen, setSubModalOpen] = useState(false)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  return (
    <Modal
      dialogRef={dialogRef}
      onClose={onClose}
      size="lg"
      // Keep the dialog open but hide its box while a stacked sub-modal is up,
      // so the two modal boxes don't visibly layer. The sub-modal renders its
      // own backdrop on top; dismissing it un-hides this box.
      boxClassName={subModalOpen ? "invisible" : undefined}
      aria-labelledby={titleId}
    >
      <Heading as="h3" className="truncate pe-8" id={titleId}>
        {assignmentName(assignment)}
      </Heading>
      <p className="mt-0.5 flex items-center gap-2 text-sm text-base-content/60">
        <MonoLtr className="truncate">{assignment.slug}</MonoLtr>
        {assignment.locked && (
          <Badge
            tone="warning"
            size="sm"
            className="gap-1 whitespace-nowrap"
            title={t("assignments.table.lockedBadgeTitle")}
          >
            <LockIcon aria-hidden="true" className="size-3" />
            {t("assignments.table.lockedBadge")}
          </Badge>
        )}
      </p>

      <div className="mt-4 flex flex-col">
        <ActionListRow
          icon={canMutate ? PencilIcon : EyeIcon}
          title={
            canMutate
              ? t("assignments.table.editAssignment")
              : t("assignments.table.viewAssignment")
          }
          description={
            canMutate
              ? t("assignments.manageModal.editDescription")
              : t("assignments.manageModal.viewDescription")
          }
          onClick={() =>
            void navigate({
              to: "/$org/$classroom/assignments/$assignment/settings",
              params: { org, classroom, assignment: assignment.slug },
            })
          }
        />
        <CopyAcceptLinkAction
          variant="row"
          org={org}
          classroom={classroom}
          assignment={assignment}
          secret={secret}
          secretPending={secretPending}
        />
        <CloneSubmissionsAction
          variant="row"
          org={org}
          classroom={classroom}
          assignment={assignment}
          onSubModalToggle={setSubModalOpen}
        />
        <TemplateAccessAction
          org={org}
          classroom={classroom}
          assignment={assignment}
          onSubModalToggle={setSubModalOpen}
        />
        {canMutate && (
          <>
            <ReuseAssignmentAction
              org={org}
              classroom={classroom}
              assignment={assignment}
              onSubModalToggle={setSubModalOpen}
            />
            <LockAssignmentAction
              variant="row"
              org={org}
              classroom={classroom}
              assignment={assignment}
            />
            <DeleteAssignmentAction
              org={org}
              classroom={classroom}
              assignment={assignment}
              onDeleteAssignment={onDeleteAssignment}
            />
          </>
        )}
      </div>
    </Modal>
  )
}

export default ManageAssignmentModal
