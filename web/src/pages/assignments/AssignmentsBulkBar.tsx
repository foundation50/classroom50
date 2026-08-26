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

// The assignments table's selection actions, rendered INSIDE the table head so
// they sit on the row that already carries the select-all checkbox. A separate
// bar above the table would mean a second select-all control for the same
// state — which is what it did before, and the two boxes disagreed on nothing
// but were confusing all the same.
//
// Only the actions that are
// genuinely plural live here — lock/unlock, delete, and reuse. Edit is
// navigation to one page, template access is a diagnostic modal rather than an
// action, clone-submissions renders a CLI command, and collect deliberately
// stays out: collect-scores.yaml scopes to one assignment or the whole
// classroom, so a selection would mean N dispatches serialized on the same
// concurrency group — the fan-out #719 evaluated and rejected. "Collect all"
// already covers the classroom case.
//
// Lock and delete go through the batched domain functions: one commit for the
// whole selection, so the classroom's history gets one entry per user action
// and a half-applied selection is impossible. Reuse cannot batch (each copy
// writes the target classroom and may create a repo), so it reports progress
// and a per-assignment outcome instead of a single verdict.

type Props = {
  org: string
  classroom: string
  // The selected assignments, already resolved against the FULL list by the
  // page (resolveSelectedRows): a row the search is hiding stays selected and
  // stays acted on, the same contract OrgMembersPage documents. Resolving it
  // here as well would be the same rule in two places.
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
  // The last action a dialog was opened for. `pending` drops to null the
  // instant the dialog starts closing, so the fading dialog would otherwise
  // re-read as the other verb for the length of the fade-out. Adjusted during
  // render (not in an effect), the same shape useLingeringOpen uses.
  const [lastLockVerb, setLastLockVerb] = useState<"lock" | "unlock">("lock")
  if (
    (pending === "lock" || pending === "unlock") &&
    pending !== lastLockVerb
  ) {
    setLastLockVerb(pending)
  }
  const [reuseOpen, setReuseOpen] = useState(false)

  // The row action is a toggle — one assignment is either locked or not, so it
  // shows one verb. A selection can be mixed, so both verbs are offered; but a
  // verb with nothing to do is disabled rather than left to answer with "every
  // selected assignment was already in that state".
  const allLocked = selected.every((a) => Boolean(a.locked))
  const noneLocked = selected.every((a) => !a.locked)
  const lock = useBulkSetAssignmentLock(org, classroom)
  const remove = useBulkDeleteAssignments(org, classroom)
  const busy = lock.isPending || remove.isPending

  // Post-success only. A slug that vanished between render and submit, or a
  // template whose access couldn't be reconciled, is not a failure of the
  // write — but it is not part of "done" either, so it gets its own line
  // rather than being folded into the success message.
  const notifyMissing = (missing: string[]) => {
    if (missing.length === 0) return
    notify({
      tone: "warning",
      key: `assignments-bulk-missing:${classroom}`,
      message: t("assignments.bulk.missingSkipped", { count: missing.length }),
    })
  }

  // Wording and the boolean travel together: four independent ternaries could
  // be flipped one at a time into a dialog that says lock and unlocks.
  // Driven by the LATCHED verb, not by `pending`: `pending` goes null the
  // moment the dialog starts closing, so reading it directly would flip an
  // unlock dialog's title, body and button to "Lock" for the fade-out's
  // length. Only the two lock verbs are latched — latching "delete" would let
  // a Delete click repaint the still-fading unlock dialog.
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

  // Nothing here clears the selection. It cannot: these dialogs are rendered
  // from the table's head cell, which the table only renders WHILE something is
  // selected — so clearing from inside a dialog's own confirm handler destroys
  // that dialog mid-close, before ConfirmModal's onClose and its fade-out ever
  // run (see the close-animation invariant in components/ui/Modal.tsx).
  //
  // Leaving it alone is also the better behaviour: the assignments stay
  // selected so a second action can follow, Clear selection is one click away,
  // and a bulk DELETE empties itself — the page resolves the selection against
  // the live list, so the deleted slugs drop out when assignments.json
  // refetches, long after the dialog has finished closing.
  //
  // No try/catch here on purpose: ConfirmModal awaits onConfirm, and a
  // rejection makes it render the message inline and STAY OPEN. Catching would
  // close the dialog as if the write had succeeded and demote the failure to a
  // toast — the one confirm flow in the app that lied about its outcome.
  const runLock = async (locked: boolean) => {
    const result = await lock.mutateAsync({ slugs, locked })
    const changed = result.changed.length
    // `outcomes` covers the slugs that were actually present. Empty means the
    // whole selection was gone, which notifyMissing reports — saying "already
    // in that state" about assignments that no longer exist would be false.
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
    // An all-missing selection commits nothing; a green "0 deleted" would
    // report a write that never happened.
    if (result.deleted.length === 0) {
      notify({ tone: "info", message: t("assignments.bulk.deleteNoChange") })
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

  // Mounted by the table's head-row takeover, which only happens with a live
  // selection; the guard keeps `allLocked`/`noneLocked` honest for any other
  // caller, since `every` on an empty selection answers true to both.
  if (count === 0) return null

  return (
    <>
      {/* Count stays left with the checkbox it belongs to; the actions sit
          right, so they line up over the per-row action icons in the column
          below rather than floating mid-table.
          Both ends are sticky because this row spans a table that scrolls
          horizontally once its eight columns outgrow the window (below roughly
          1400px). Without it the actions ride out past the right edge and the
          selection reads as an announcement with nothing to act on — the count
          visible, every button off-screen. Sticky pins each end to the
          SCROLLPORT, so the alignment survives at any width. */}
      <div className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2">
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
          {/* Destructive, so the glyph is red — a solid red button would
              outshout everything beside it; the confirm dialog carries the
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
          {/* Dismissal, not an action on the assignments — ghost keeps it out
              of the group of four. */}
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

      {/* One dialog for both directions — they differ only in wording and in
          the boolean they pass. Neither is destructive: locking is reversible
          and unlocking restores what it removed, so no type-to-confirm. */}
      <ConfirmModal
        open={pending === "lock" || pending === "unlock"}
        title={t(lockCopy.title, { count })}
        description={t(lockCopy.body)}
        confirmLabel={t(lockCopy.label)}
        dangerous={false}
        needsConfirm={false}
        onConfirm={() => runLock(lockCopy.locked)}
        onClose={() => setPending(null)}
      />

      {/* Type-to-confirm: deleting several assignments at once is the one
          action here with no undo in the app. */}
      <ConfirmModal
        open={pending === "delete"}
        title={t("assignments.bulk.deleteTitle", { count })}
        description={t("assignments.bulk.deleteBody")}
        confirmText={t("assignments.bulk.deleteConfirmWord")}
        confirmLabel={t("assignments.bulk.delete")}
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
