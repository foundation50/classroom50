import { useState } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui"
import {
  DuplicateIcon,
  LockIcon,
  TrashIcon,
  UnlockIcon,
  XIcon,
} from "@/components/ui/icons"
import { ConfirmModal } from "@/components/modals"
import { useToast } from "@/context/notifications/NotificationProvider"
import {
  useBulkDeleteAssignments,
  useBulkSetAssignmentLock,
} from "@/hooks/mutations/useBulkAssignmentActions"
import { BulkReuseAssignmentsModal } from "@/components/modals/BulkReuseAssignmentsModal"
import type { Assignment } from "@/types/classroom"

// The assignments table's selection actions, rendered inside the table head
// so the row that carries the select-all checkbox also carries what can be
// done with the selection.
//
// Only the genuinely plural actions live here. Edit navigates to one page,
// template access is a diagnostic, clone-submissions renders a CLI command,
// and collect would mean N dispatches serialized on one concurrency group
// (rejected in #719; "Collect all" already covers the classroom).

type Props = {
  org: string
  classroom: string
  // Already resolved against the full list by the page: a row the search hides
  // stays selected and acted on.
  selected: Assignment[]
  onClearSelection: () => void
}

export function AssignmentsBulkBar({
  org,
  classroom,
  selected,
  onClearSelection,
}: Props) {
  const { t } = useTranslation()
  const { notify } = useToast()

  const slugs = selected.map((a) => a.slug)
  const count = selected.length

  const [pending, setPending] = useState<"lock" | "unlock" | "delete" | null>(
    null,
  )
  // Latched so the dialog keeps its verb while fading out after `pending`
  // drops to null. Adjusted during render, like useLingeringOpen.
  const [lastLockVerb, setLastLockVerb] = useState<"lock" | "unlock">("lock")
  if (
    (pending === "lock" || pending === "unlock") &&
    pending !== lastLockVerb
  ) {
    setLastLockVerb(pending)
  }
  const [reuseOpen, setReuseOpen] = useState(false)

  // A selection can be mixed, so both verbs are offered; one with nothing to
  // do is disabled.
  const allLocked = selected.every((a) => Boolean(a.locked))
  const noneLocked = selected.every((a) => !a.locked)
  const lock = useBulkSetAssignmentLock(org, classroom)
  const remove = useBulkDeleteAssignments(org, classroom)
  const busy = lock.isPending || remove.isPending

  // A slug that vanished between render and submit isn't a failure, but isn't
  // part of "done" either.
  const notifyMissing = (missing: string[]) => {
    if (missing.length === 0) return
    notify({
      tone: "warning",
      key: `assignments-bulk-missing:${classroom}`,
      message: t("assignments.bulk.missingSkipped", { count: missing.length }),
    })
  }

  // Wording and the boolean travel together so they can't be flipped apart.
  const lockCopy =
    lastLockVerb === "unlock"
      ? {
          title: "assignments.bulk.unlockTitle",
          body: "assignments.bulk.unlockBody",
          label: "assignments.bulk.unlock",
          locked: false,
        }
      : {
          title: "assignments.bulk.lockTitle",
          body: "assignments.bulk.lockBody",
          label: "assignments.bulk.lock",
          locked: true,
        }

  // Neither handler clears the selection: the dialogs live in the head cell
  // that a selection keeps mounted, so clearing would destroy them mid-close.
  // A bulk delete empties itself once assignments.json refetches. No try/catch
  // either: ConfirmModal renders a rejection inline and stays open.
  const runLock = async (locked: boolean) => {
    const result = await lock.mutateAsync({ slugs, locked })
    const changed = result.changed.length
    // Empty `outcomes` means the whole selection was gone; notifyMissing
    // covers that.
    if (changed === 0) {
      if (result.outcomes.length > 0) {
        notify({ tone: "info", message: t("assignments.bulk.lockNoChange") })
      }
    } else {
      notify({
        tone: "success",
        key: `assignments-bulk:${classroom}`,
        message: t(
          locked ? "assignments.bulk.lockDone" : "assignments.bulk.unlockDone",
          { count: changed },
        ),
      })
    }
    notifyMissing(result.missing)
    const warned = result.outcomes.filter((o) => o.templateAccessWarning)
    if (warned.length > 0) {
      notify({
        tone: "warning",
        key: `assignments-bulk-template:${classroom}`,
        message: t("assignments.bulk.templateWarnings", {
          count: warned.length,
        }),
      })
    }
  }

  const runDelete = async () => {
    const result = await remove.mutateAsync({ slugs })
    // An all-missing selection commits nothing, and notifyMissing already says
    // so.
    if (result.deleted.length === 0) {
      if (result.missing.length === 0) {
        notify({ tone: "info", message: t("assignments.bulk.deleteNoChange") })
      }
    } else {
      notify({
        tone: "success",
        key: `assignments-bulk:${classroom}`,
        message: t("assignments.bulk.deleteDone", {
          count: result.deleted.length,
        }),
      })
    }
    notifyMissing(result.missing)
  }

  // `every` on an empty selection answers true to both lock predicates.
  if (count === 0) return null

  return (
    <>
      {/* Both ends are sticky: the table scrolls horizontally below roughly
          1400px, and without the pins the actions ride off the right edge. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className="sticky start-0 text-sm font-medium tabular-nums">
          {t("assignments.bulk.selectedCount", { count })}
        </span>
        <div className="sticky end-0 flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            variant="neutral"
            shape="square"
            disabled={busy || allLocked}
            title={
              allLocked
                ? t("assignments.bulk.lockAllLocked")
                : t("assignments.bulk.lock")
            }
            aria-label={t("assignments.bulk.lock")}
            onClick={() => setPending("lock")}
          >
            <LockIcon aria-hidden="true" className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="neutral"
            shape="square"
            disabled={busy || noneLocked}
            title={
              noneLocked
                ? t("assignments.bulk.unlockNoneLocked")
                : t("assignments.bulk.unlock")
            }
            aria-label={t("assignments.bulk.unlock")}
            onClick={() => setPending("unlock")}
          >
            <UnlockIcon aria-hidden="true" className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="neutral"
            shape="square"
            disabled={busy}
            title={t("assignments.bulk.reuse")}
            aria-label={t("assignments.bulk.reuse")}
            onClick={() => setReuseOpen(true)}
          >
            <DuplicateIcon aria-hidden="true" className="size-4" />
          </Button>
          {/* Red glyph, not a red button: the confirm dialog carries the
              danger tone. */}
          <Button
            size="sm"
            variant="neutral"
            shape="square"
            className="text-error"
            disabled={busy}
            title={t("assignments.bulk.delete")}
            aria-label={t("assignments.bulk.delete")}
            onClick={() => setPending("delete")}
          >
            <TrashIcon aria-hidden="true" className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            shape="square"
            title={t("assignments.bulk.clearSelection")}
            aria-label={t("assignments.bulk.clearSelection")}
            onClick={onClearSelection}
          >
            <XIcon aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </div>

      {/* Reversible both ways, so no type-to-confirm and no warning. */}
      <ConfirmModal
        open={pending === "lock" || pending === "unlock"}
        title={t(lockCopy.title, { count })}
        description={t(lockCopy.body)}
        confirmLabel={t(lockCopy.label)}
        tone="warning"
        needsConfirm={false}
        onConfirm={() => runLock(lockCopy.locked)}
        onClose={() => setPending(null)}
      />

      {/* The one action here with no undo in the app. */}
      <ConfirmModal
        open={pending === "delete"}
        title={t("assignments.bulk.deleteTitle", { count })}
        description={t("assignments.bulk.deleteBody")}
        confirmText={t("assignments.bulk.deleteConfirmWord")}
        confirmLabel={t("assignments.bulk.delete")}
        tone="error"
        warning={t("assignments.bulk.deleteWarning")}
        onConfirm={runDelete}
        onClose={() => setPending(null)}
      />

      {reuseOpen && (
        <BulkReuseAssignmentsModal
          org={org}
          sources={selected}
          onClose={() => setReuseOpen(false)}
        />
      )}
    </>
  )
}

export default AssignmentsBulkBar
