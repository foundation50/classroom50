import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { DropdownMenu } from "@/components/ui"
import {
  CalendarIcon,
  DuplicateIcon,
  LockIcon,
  TrashIcon,
  UnlockIcon,
} from "@/components/ui/icons"
import { ConfirmModal } from "@/components/modals"
import { BulkSelectionCluster } from "@/components/bulk/BulkSelectionCluster"
import type { CloseSubmissionTarget } from "@/components/bulk/closeSubmissionFanOut"
import { useToast } from "@/context/notifications/NotificationProvider"
import {
  useBulkDeleteAssignments,
  useBulkSetAssignmentLock,
} from "@/hooks/mutations/useBulkAssignmentActions"
import { BulkCloseSubmissionModal } from "@/components/modals/BulkCloseSubmissionModal"
import { BulkReuseAssignmentsModal } from "@/components/modals/BulkReuseAssignmentsModal"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import useGetStudents from "@/hooks/useGetStudents"
import { useStaffCapabilities } from "@/hooks/useStaffCapabilities"
import { acceptedUsernames } from "@/pages/submissions/dashboard"
import type { Assignment } from "@/types/classroom"

// The assignments toolbar's selection cluster (count + Actions menu + Clear),
// shown only while rows are selected. Always mounted, like the roster's, so a
// dialog's close animation survives the selection changing under it.
//
// Only the genuinely plural actions live here. Edit navigates to one page,
// template access is a diagnostic, clone-submissions renders a CLI command,
// and collect would mean N dispatches serialized on one concurrency group
// (rejected in #719; "Collect all" already covers the classroom).
//
// Close/reopen submission is the exception to "one commit and done": the flag
// is one commit, but the lockdown it stands for is per student repo, so the
// modal owns a fan-out. Only individual, non-empty_repo assignments qualify —
// a group/team repo's membership is founder-managed and an empty_repo
// assignment has no student repo to downgrade (#912).

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
  // Latched like the lock verb, so the dialog keeps its wording while it fades.
  const [closeMode, setCloseMode] = useState<"close" | "reopen" | null>(null)
  const [lastCloseMode, setLastCloseMode] = useState<"close" | "reopen">(
    "close",
  )
  if (closeMode && closeMode !== lastCloseMode) {
    setLastCloseMode(closeMode)
  }

  // A selection can be mixed, so both verbs are offered; one with nothing to
  // do is disabled.
  const allLocked = selected.every((a) => Boolean(a.locked))
  const noneLocked = selected.every((a) => !a.locked)
  // Close/reopen covers the shapes whose student repos the fan-out can reach.
  const closable = useMemo(
    () => selected.filter((a) => a.mode === "individual" && !a.empty_repo),
    [selected],
  )
  const skipped = useMemo(
    () => selected.filter((a) => !closable.includes(a)).map((a) => a.slug),
    [selected, closable],
  )

  const allClosed = closable.length > 0 && closable.every((a) => a.closed)
  const noneClosed = closable.every((a) => !a.closed)
  // Both reads are already in the page's cache (the table's Accepted column
  // and the funnel roster), so resolving who accepted costs no extra request.
  const {
    data: orgRepos,
    isPending: reposPending,
    isError: reposError,
  } = useGetOrgRepos(org)
  const {
    students,
    isLoading: studentsLoading,
    isError: studentsError,
  } = useGetStudents(org, classroom)
  // Without both, every assignment resolves to zero accepted owners: the run
  // would commit the flag and report "0 of 0 repositories" while every student
  // kept write. Fail closed — the entries wait rather than under-apply.
  const ownersResolvable =
    !reposPending && !reposError && !studentsLoading && !studentsError
  // Reopen restores write, so it may only touch assignments that are actually
  // closed: fanning out over the whole selection would re-grant push on repos
  // a teacher downgraded per student in the gradebook, and overwrite a
  // non-push student_permission. Close can cover every eligible assignment —
  // re-asserting pull on an already-closed one changes nothing.
  const closeTargets = useMemo<CloseSubmissionTarget[]>(
    () =>
      closable
        .filter((a) => lastCloseMode !== "reopen" || a.closed)
        .map((a) => ({
          slug: a.slug,
          owners: [...acceptedUsernames(orgRepos, classroom, a.slug, students)],
        })),
    [closable, lastCloseMode, orgRepos, classroom, students],
  )
  // The per-repo collaborator write needs repo admin, which only an org owner
  // has — the same gate the single-assignment action carries.
  const { isOwner } = useStaffCapabilities()

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

  // Neither handler clears the selection (Clear is one click away, and a bulk
  // delete empties itself once assignments.json refetches). No try/catch
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
    // Named per slug: the teacher has to know which ones to run again.
    const warned = result.outcomes.filter((o) => o.templateAccessWarning)
    if (warned.length > 0) {
      notify({
        tone: "warning",
        key: `assignments-bulk-template:${classroom}`,
        message: t("assignments.bulk.templateWarnings", {
          count: warned.length,
          slugs: warned.map((o) => o.slug).join(", "),
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

  return (
    <>
      {count > 0 ? (
        <BulkSelectionCluster
          countLabel={t("assignments.bulk.selectedCount", { count })}
          onClearSelection={onClearSelection}
        >
          <DropdownMenu.Item
            icon={LockIcon}
            label={t("assignments.bulk.lock")}
            disabled={busy || allLocked}
            title={allLocked ? t("assignments.bulk.lockAllLocked") : undefined}
            onSelect={() => setPending("lock")}
          />
          <DropdownMenu.Item
            icon={UnlockIcon}
            label={t("assignments.bulk.unlock")}
            disabled={busy || noneLocked}
            title={
              noneLocked ? t("assignments.bulk.unlockNoneLocked") : undefined
            }
            onSelect={() => setPending("unlock")}
          />
          {isOwner && (
            <>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                icon={CalendarIcon}
                label={t("assignments.bulk.closeSubmission.menuLabel")}
                disabled={
                  busy ||
                  closable.length === 0 ||
                  allClosed ||
                  !ownersResolvable
                }
                title={
                  closable.length === 0
                    ? t("assignments.bulk.closeSubmission.noneEligible")
                    : allClosed
                      ? t("assignments.bulk.closeSubmission.allClosed")
                      : !ownersResolvable
                        ? t("assignments.bulk.closeSubmission.ownersUnknown")
                        : t("assignments.bulk.closeSubmission.menuTitle")
                }
                onSelect={() => setCloseMode("close")}
              />
              <DropdownMenu.Item
                icon={CalendarIcon}
                label={t("assignments.bulk.closeSubmission.reopenMenuLabel")}
                disabled={
                  busy ||
                  closable.length === 0 ||
                  noneClosed ||
                  !ownersResolvable
                }
                title={
                  closable.length === 0
                    ? t("assignments.bulk.closeSubmission.noneEligible")
                    : noneClosed
                      ? t("assignments.bulk.closeSubmission.noneClosed")
                      : !ownersResolvable
                        ? t("assignments.bulk.closeSubmission.ownersUnknown")
                        : t("assignments.bulk.closeSubmission.reopenMenuTitle")
                }
                onSelect={() => setCloseMode("reopen")}
              />
              <DropdownMenu.Separator />
            </>
          )}
          <DropdownMenu.Item
            icon={DuplicateIcon}
            label={t("assignments.bulk.reuse")}
            disabled={busy}
            onSelect={() => setReuseOpen(true)}
          />
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            icon={TrashIcon}
            label={t("assignments.bulk.delete")}
            destructive
            disabled={busy}
            onSelect={() => setPending("delete")}
          />
        </BulkSelectionCluster>
      ) : null}

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

      <BulkCloseSubmissionModal
        open={closeMode !== null}
        onClose={() => setCloseMode(null)}
        org={org}
        classroom={classroom}
        mode={lastCloseMode}
        targets={closeTargets}
        skipped={skipped}
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
