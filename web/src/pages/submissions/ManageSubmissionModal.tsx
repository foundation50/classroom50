import { useEffect, useId, useRef } from "react"
import { useTranslation } from "react-i18next"
import { UsersRound } from "lucide-react"

import GitHub from "@/assets/github.svg?react"
import { Modal, MonoLtr } from "@/components/ui"
import {
  SubmissionActionList,
  type SubmissionActionListProps,
} from "@/pages/submissions/SubmissionsRowActions"
import { ActionListRow } from "@/pages/submissions/actionLayout"

// The submission hub: one entry point that gathers every per-submission action
// behind the row's Manage control. It shows the identity + repo it acts on,
// then the action list. The rich access/members editors are not nested here —
// they hand off (this modal closes and the caller opens the dedicated modal),
// so a dialog never stacks on the hub.
//
// Mounted only while a row is selected (the caller gates + remounts via `key`),
// so it opens once on mount; Esc/backdrop/X fire onClose to clear the selection.
export const ManageSubmissionModal = ({
  onClose,
  title,
  subtitle,
  repo,
  repoHref,
  isGroup,
  onManageMembers,
  action,
}: {
  onClose: () => void
  // The submission's display name (student name) or, for a group, the repo name.
  title: string
  // Secondary line under the title (e.g. GitHub login · section), when known.
  subtitle?: string
  repo: string
  repoHref?: string
  isGroup: boolean
  // Group hand-off: closes the hub and opens the members modal. Individual
  // access hand-off is carried on `action.onManageAccess`.
  onManageMembers?: () => void
  // Everything SubmissionActionList needs, minus the access hand-off, which the
  // hub wraps so it closes first (below).
  action: Omit<SubmissionActionListProps, "onManageAccess"> & {
    onManageAccess?: () => void
  }
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()
  const { t } = useTranslation()

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  // Access/members editors are separate modals; close the hub first so only one
  // dialog is ever open (no modal-on-modal).
  const handleManageAccess = () => {
    dialogRef.current?.close()
    action.onManageAccess?.()
  }

  const handleManageMembers = () => {
    dialogRef.current?.close()
    onManageMembers?.()
  }

  return (
    <Modal
      dialogRef={dialogRef}
      onClose={onClose}
      size="md"
      aria-labelledby={titleId}
    >
      <h3 id={titleId} className="truncate pe-8 text-lg font-bold">
        {title}
      </h3>
      {subtitle ? (
        <p className="mt-0.5 truncate text-sm text-base-content/60">
          {subtitle}
        </p>
      ) : null}
      {repoHref ? (
        <a
          className="mt-2 inline-flex w-fit items-center gap-1.5 link link-hover"
          href={repoHref}
          target="_blank"
          rel="noreferrer"
          title={t("submissions.table.viewRepo")}
        >
          <GitHub aria-hidden="true" className="size-4 shrink-0" />
          <MonoLtr className="text-sm">{repo}</MonoLtr>
        </a>
      ) : (
        <p className="mt-2 inline-flex w-fit items-center gap-1.5 text-base-content/50">
          <GitHub aria-hidden="true" className="size-4 shrink-0" />
          <MonoLtr className="text-sm">{repo}</MonoLtr>
        </p>
      )}

      <div className="mt-4 divide-y divide-base-200">
        <SubmissionActionList
          {...action}
          onManageAccess={
            action.onManageAccess ? handleManageAccess : undefined
          }
        />
        {isGroup && onManageMembers ? (
          <ActionListRow
            icon={UsersRound}
            title={t("submissions.table.members")}
            description={t("submissions.manageModal.membersDescription")}
            onClick={handleManageMembers}
          />
        ) : null}
      </div>
    </Modal>
  )
}

export default ManageSubmissionModal
