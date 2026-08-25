import { useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import {
  CheckIcon,
  DownloadIcon,
  DuplicateIcon,
  LinkIcon,
  LockIcon,
  ShieldCheckIcon,
  TrashIcon,
  UnlockIcon,
} from "@/components/ui/icons"

import { Button, EmphasisLtr } from "@/components/ui"
import { ConfirmModal } from "@/components/modals"
import { ReuseAssignmentModal } from "@/components/modals/ReuseAssignmentModal"
import { TemplateAccessModal } from "@/components/modals/TemplateAccessModal"
import { CloneSubmissionsModal } from "@/pages/submissions/CloneSubmissionsModal"
import { ActionListRow } from "@/pages/submissions/actionLayout"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { acceptLinkUrl } from "@/util/acceptLink"
import { useDeleteAssignment } from "@/hooks/mutations/useDeleteAssignment"
import { useSetAssignmentLock } from "@/hooks/mutations/useSetAssignmentLock"
import { useToast } from "@/context/notifications/NotificationProvider"
import type { Assignment } from "@/types/classroom"

// Assignment display name with a slug fallback, shared by the action labels.
export const assignmentName = (assignment: Assignment): string =>
  assignment.name || assignment.slug

// Each action renders in one of two shapes: the table row's compact icon
// button (`variant="icon"`), or the manage-assignment hub's labeled list row
// (`variant="row"`). One component per action so the labels, gating, and the
// owned confirm/sub-modal exist in exactly one place.
type ActionVariant = "icon" | "row"

// Actions that present their own stacked modal notify the hub through
// `onSubModalToggle` so it can hide its box while the sub-modal is up (the
// same no-visible-layering convention as ManageSubmissionModal). The icon
// variant runs outside the hub and just omits the callback.
type SubModalProps = {
  onSubModalToggle?: (open: boolean) => void
}

// Per-row "Copy accept link" — reaching the same link through the submissions
// page's share modal costs four clicks per assignment (issue #731). Copying
// mutates nothing, so it stays on archived and TA rows too.
//
// Disabled while the classroom read is unresolved — still loading, or failed:
// either way `secret` is undefined, indistinguishable from "unprotected", and
// copying a protected classroom's link without its `?k=` would hand students a
// silent 404.
export const CopyAcceptLinkAction = ({
  org,
  classroom,
  assignment,
  secret,
  secretPending = false,
  variant = "icon",
}: {
  org: string
  classroom: string
  assignment: Assignment
  secret?: string
  secretPending?: boolean
  variant?: ActionVariant
}) => {
  const { t } = useTranslation()
  const { copied, copy } = useCopyToClipboard(
    acceptLinkUrl(org, classroom, assignment.slug, secret),
    1500,
  )

  const state = secretPending
    ? t("assignments.table.copyLinkPending")
    : copied
      ? t("assignments.table.linkCopied")
      : undefined

  if (variant === "row") {
    return (
      <ActionListRow
        icon={copied ? CheckIcon : LinkIcon}
        title={t("assignments.table.copyLinkTitle")}
        description={
          state ?? t("assignments.manageModal.acceptLinkDescription")
        }
        onClick={() => void copy()}
        disabled={secretPending}
        ariaLabel={t("assignments.table.copyLinkAria", {
          name: assignmentName(assignment),
        })}
      />
    )
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      shape="circle"
      disabled={secretPending}
      title={state ?? t("assignments.table.copyLinkTitle")}
      aria-label={t("assignments.table.copyLinkAria", {
        name: assignmentName(assignment),
      })}
      onClick={(e) => {
        e.stopPropagation()
        void copy()
      }}
    >
      {copied ? (
        <CheckIcon aria-hidden="true" className="size-4 text-success" />
      ) : (
        <LinkIcon aria-hidden="true" className="size-4" />
      )}
    </Button>
  )
}

// Per-row "Clone all submissions": opens the modal with the `gh teacher
// download` command for this assignment — the same CLI hand-off the
// submissions page offers, one page earlier. A Download icon (as in GitHub
// Classroom): the icon names the user's goal — getting the submissions onto
// their machine — not the CLI mechanism. Read-only, so it survives the
// archived/can't-author gate.
export const CloneSubmissionsAction = ({
  org,
  classroom,
  assignment,
  variant = "icon",
  onSubModalToggle,
}: {
  org: string
  classroom: string
  assignment: Assignment
  variant?: ActionVariant
} & SubModalProps) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const setOpenAndNotify = (next: boolean) => {
    setOpen(next)
    onSubModalToggle?.(next)
  }
  const cli = `gh teacher download ${org} ${classroom} ${assignment.slug}`

  return (
    <>
      {variant === "row" ? (
        <ActionListRow
          icon={DownloadIcon}
          title={t("submissions.cloneAll.heading")}
          description={t("assignments.manageModal.cloneDescription")}
          onClick={() => setOpenAndNotify(true)}
          ariaLabel={t("assignments.table.cloneAria", {
            name: assignmentName(assignment),
          })}
        />
      ) : (
        <Button
          variant="ghost"
          size="sm"
          shape="circle"
          title={t("submissions.cloneAll.buttonTitle")}
          aria-label={t("assignments.table.cloneAria", {
            name: assignmentName(assignment),
          })}
          onClick={(e) => {
            e.stopPropagation()
            setOpenAndNotify(true)
          }}
        >
          <DownloadIcon aria-hidden="true" className="size-4" />
        </Button>
      )}
      <CloneSubmissionsModal
        open={open}
        onClose={() => setOpenAndNotify(false)}
        cli={cli}
      />
    </>
  )
}

// "Template access" (hub only): review which template repo the assignment
// uses and which GitHub teams can read it, and (org owners only) re-grant the
// classroom student/TA teams read — the acceptance-blocking fix from issue
// #305. Renders nothing without a template.
export const TemplateAccessAction = ({
  org,
  classroom,
  assignment,
  onSubModalToggle,
}: {
  org: string
  classroom: string
  assignment: Assignment
} & SubModalProps) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const setOpenAndNotify = (next: boolean) => {
    setOpen(next)
    onSubModalToggle?.(next)
  }
  if (!assignment.template) return null

  return (
    <>
      <ActionListRow
        icon={ShieldCheckIcon}
        title={t("assignments.template.accessModal.triggerTitle")}
        description={t("assignments.manageModal.templateAccessDescription")}
        onClick={() => setOpenAndNotify(true)}
        ariaLabel={t("assignments.template.accessModal.triggerAria", {
          name: assignmentName(assignment),
        })}
      />
      {open ? (
        <TemplateAccessModal
          org={org}
          classroom={classroom}
          assignment={assignment}
          onClose={() => setOpenAndNotify(false)}
        />
      ) : null}
    </>
  )
}

// "Reuse in another classroom" (hub only) — a Duplicate icon, not Copy:
// Octicons reserves `copy` for copy-to-clipboard, and this duplicates the
// assignment into another classroom.
export const ReuseAssignmentAction = ({
  org,
  classroom,
  assignment,
  onSubModalToggle,
}: {
  org: string
  classroom: string
  assignment: Assignment
} & SubModalProps) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const setOpenAndNotify = (next: boolean) => {
    setOpen(next)
    onSubModalToggle?.(next)
  }

  return (
    <>
      <ActionListRow
        icon={DuplicateIcon}
        title={t("assignments.table.reuseTitle")}
        description={t("assignments.manageModal.reuseDescription")}
        onClick={() => setOpenAndNotify(true)}
        ariaLabel={t("assignments.table.reuseAria")}
      />
      {open ? (
        <ReuseAssignmentModal
          org={org}
          classroom={classroom}
          assignment={assignment}
          onClose={() => setOpenAndNotify(false)}
        />
      ) : null}
    </>
  )
}

// Lock/Unlock. Locking closes the assignment to every student (accept +
// submission surfaces refuse it) and, for a private in-org template, removes
// the student team's read on it; unlocking reverses both. The template side
// effect can partly fail without failing the flag flip, so a non-fatal
// templateAccessWarning surfaces as a warning toast. The confirm stacks on
// the hub like the submission hub's regrade confirm — small enough that the
// hub box stays visible underneath.
export const LockAssignmentAction = ({
  org,
  classroom,
  assignment,
  variant = "icon",
}: {
  org: string
  classroom: string
  assignment: Assignment
  variant?: ActionVariant
}) => {
  const { t } = useTranslation()
  const { notify } = useToast()
  const [open, setOpen] = useState(false)
  const locked = Boolean(assignment.locked)
  const label = assignmentName(assignment)
  // The lock-vs-unlock label set, chosen once so the JSX below reads one field
  // each instead of repeating the `locked ? … : …` branch at every attribute.
  const copy = locked
    ? {
        title: t("assignments.table.unlockTitle"),
        aria: t("assignments.table.unlockAria", { name: label }),
        description: t("assignments.manageModal.unlockDescription"),
        modalTitle: t("assignments.table.unlockTitleModal"),
        descriptionKey: "assignments.table.unlockDescription",
        confirm: t("assignments.table.unlockConfirm"),
      }
    : {
        title: t("assignments.table.lockTitle"),
        aria: t("assignments.table.lockAria", { name: label }),
        description: t("assignments.manageModal.lockDescription"),
        modalTitle: t("assignments.table.lockTitleModal"),
        descriptionKey: "assignments.table.lockDescription",
        confirm: t("assignments.table.lockConfirm"),
      }
  const setLock = useSetAssignmentLock(org, classroom, (result) => {
    if (result.templateAccessWarning) {
      notify({ tone: "warning", message: result.templateAccessWarning })
      return
    }
    notify({
      tone: "success",
      message: result.locked
        ? t("assignments.table.lockSuccess", { name: label })
        : t("assignments.table.unlockSuccess", { name: label }),
    })
  })

  return (
    <>
      {variant === "row" ? (
        <ActionListRow
          icon={locked ? UnlockIcon : LockIcon}
          title={copy.title}
          description={copy.description}
          onClick={() => setOpen(true)}
          ariaLabel={copy.aria}
        />
      ) : (
        <Button
          variant="ghost"
          size="sm"
          shape="circle"
          className={locked ? "text-warning" : undefined}
          title={copy.title}
          aria-label={copy.aria}
          onClick={(e) => {
            e.stopPropagation()
            setOpen(true)
          }}
        >
          {locked ? (
            <UnlockIcon aria-hidden="true" className="size-4" />
          ) : (
            <LockIcon aria-hidden="true" className="size-4" />
          )}
        </Button>
      )}

      <ConfirmModal
        open={open}
        title={copy.modalTitle}
        description={
          <Trans
            i18nKey={copy.descriptionKey}
            values={{ assignment: label }}
            components={{
              assignment: <EmphasisLtr className="text-base-content" />,
            }}
          />
        }
        confirmLabel={copy.confirm}
        cancelLabel={t("assignments.table.lockCancel")}
        dangerous={!locked}
        needsConfirm={false}
        onConfirm={async () => {
          await setLock.mutateAsync({
            org,
            classroom,
            slug: assignment.slug,
            locked: !locked,
          })
        }}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

// Delete (hub only): typed-slug confirm, then invalidation via the caller's
// `onDeleteAssignment` (cache keys stay at the table, per the mutation-hook
// convention).
export const DeleteAssignmentAction = ({
  org,
  classroom,
  assignment,
  onDeleteAssignment,
}: {
  org: string
  classroom: string
  assignment: Assignment
  onDeleteAssignment: () => void
}) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const deleteAssignmentMutation = useDeleteAssignment()

  return (
    <>
      <ActionListRow
        icon={TrashIcon}
        title={t("assignments.manageModal.delete")}
        description={t("assignments.manageModal.deleteDescription")}
        onClick={() => setOpen(true)}
        ariaLabel={t("assignments.table.deleteAria", {
          name: assignmentName(assignment),
        })}
      />

      <ConfirmModal
        open={open}
        title={t("assignments.table.deleteTitle")}
        description={
          <Trans
            i18nKey="assignments.table.deleteDescription"
            values={{
              assignment: assignmentName(assignment),
              classroom: `${org}/${classroom}`,
            }}
            components={{
              assignment: <EmphasisLtr className="text-base-content" />,
              classroom: <EmphasisLtr className="text-base-content" />,
            }}
          />
        }
        confirmText={assignment.slug}
        confirmLabel={t("assignments.table.deleteConfirm")}
        cancelLabel={t("assignments.table.deleteCancel")}
        dangerous
        onConfirm={async () => {
          await deleteAssignmentMutation.mutateAsync({
            org,
            classroom,
            assignment: assignment.slug,
          })
          onDeleteAssignment()
        }}
        onClose={() => setOpen(false)}
      />
    </>
  )
}
