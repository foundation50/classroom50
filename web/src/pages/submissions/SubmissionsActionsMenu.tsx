import {
  CalendarIcon,
  TriangleDownIcon,
  DownloadIcon,
  FileZipIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  GlobeIcon,
  GraphIcon,
  LinkExternalIcon,
  LockIcon,
  PauseIcon,
  PlayIcon,
  ShieldCheckIcon,
  SlidersIcon,
  SyncIcon,
  TrashIcon,
  UnlockIcon,
} from "@/components/ui/icons"
import { useTranslation } from "react-i18next"

import { Button, DropdownMenu } from "@/components/ui"

// Consolidates the workflow actions (Collect now / Regrade all / View workflow)
// plus the CSV export and Metrics into one dropdown so the toolbar stays
// compact and the roster surfaces higher. Share (accept link) is a standalone
// button next to the search bar (its own prominent affordance), not in here.
// daisyUI dropdowns are focus-driven; selecting an item blurs to close.
// Disabled/loading gating mirrors the former inline buttons.
export function SubmissionsActionsMenu({
  collecting,
  regrading,
  regradeAllActive,
  canRegradeAll = true,
  emptyRoster,
  skipsGrading = false,
  onMetrics,
  onCollect,
  onRegradeAll,
  onOpenAllPrs,
  viewHref,
  viewLabel,
  onDownloadCsv,
  downloadDisabled,
  onDownloadAll,
  downloadAllDisabled,
  onBulkAccess,
  onBulkFeatures,
  onBulkVisibility,
  onBulkTrigger,
  onBulkPause,
  onBulkResume,
  locked = false,
  lockPending = false,
  onLockToggle,
  closed = false,
  onCloseToggle,
  onDelete,
}: {
  collecting: boolean
  regrading: boolean
  regradeAllActive: boolean
  // Whether the viewer may trigger "Regrade all" (teacher|hta). A plain TA can
  // Collect and regrade individual rows but not batch-regrade; GitHub 403s a
  // pull-only TA regardless, so this is the UX gate. Defaults true for callers
  // that don't gate (the item stays visible).
  canRegradeAll?: boolean
  emptyRoster: boolean
  // The assignment never autogrades (empty_repo OR no_autograder), so the
  // grading actions (Regrade all / View workflow) are hidden — Collect and the
  // exports stay.
  skipsGrading?: boolean
  // Opens the Metrics modal. Omitted (hidden) in live view, where the graded
  // snapshot stats don't apply.
  onMetrics?: () => void
  onCollect: () => void
  onRegradeAll: () => void
  // Opens the "Open all Feedback PRs" modal. Omitted (hidden) when the viewer
  // can't write every repo (non-owner) or the assignment has no Feedback PRs
  // (empty_repo).
  onOpenAllPrs?: () => void
  viewHref: string
  viewLabel: string
  onDownloadCsv: () => void
  downloadDisabled: boolean
  // Read-only (any viewer), so not owner-gated like Open-all-PRs; hidden only
  // when there's nothing to fetch (via downloadAllDisabled).
  onDownloadAll: () => void
  downloadAllDisabled: boolean
  // Opens the whole-assignment "Set student repo access" modal. Omitted (item
  // hidden) when the viewer can't write every repo (non-owner), for a group or
  // empty_repo assignment, or when there are no accepted repos to target.
  onBulkAccess?: () => void
  // Opens the whole-assignment "Set repository features" modal. Same gate as
  // onBulkAccess (owner, individual, non-empty, has accepted repos); omitted
  // otherwise. Reconciles existing repos with the assignment's repo_features.
  onBulkFeatures?: () => void
  // Opens the whole-assignment "Change repository visibility" modal (issue
  // #766). Same gate as onBulkFeatures; omitted otherwise.
  onBulkVisibility?: () => void
  // Opens the whole-assignment "Update autograding triggers" modal (retrofits
  // each repo's shim to the assignment's submission_mode). Bulk-features gate
  // plus default-autograder only; omitted otherwise.
  onBulkTrigger?: () => void
  // Opens the whole-assignment "Pause autograding" modal (disables the
  // autograde workflow in every accepted repo). Same gate as onBulkTrigger.
  onBulkPause?: () => void
  // Opens the whole-assignment "Resume autograding" modal (re-enables the
  // workflow). Same gate as onBulkPause; the pair reverse each other.
  onBulkResume?: () => void
  // Current locked state, for the Lock/Unlock item's label and icon.
  locked?: boolean
  // Whether a lock/unlock is mid-flight, to disable the item and show progress.
  lockPending?: boolean
  // Opens the lock/unlock confirmation. Omitted (item hidden) when the viewer
  // can't author assignments (teacher|hta) — the page owns the mutation, this
  // is just the affordance.
  onLockToggle?: () => void
  // Current closed state, for the Close/Reopen item's label and icon.
  closed?: boolean
  // Opens the Close/Reopen submission modal. Same gate as onBulkAccess (owner,
  // individual, non-empty repo shape) plus authoring tier; omitted otherwise.
  // The page owns the modal and the closed-flag mutation.
  onCloseToggle?: () => void
  // Opens the delete-assignment confirm. Omitted (item hidden) unless the
  // viewer can author on an unarchived classroom; the page owns the mutation.
  onDelete?: () => void
}) {
  const { t } = useTranslation()
  const busy = collecting || regrading
  const disabledActions = busy || emptyRoster

  const closeMenu = () => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
  }

  const collectTitle = emptyRoster
    ? t("submissions.collect.titleEmptyRoster")
    : regrading
      ? t("submissions.collect.titleRegrading")
      : t("submissions.collect.title")
  const regradeTitle = emptyRoster
    ? t("submissions.regradeAll.titleEmptyRoster")
    : collecting
      ? t("submissions.regradeAll.titleCollecting")
      : regrading
        ? t("submissions.regradeAll.titleRegrading")
        : t("submissions.regradeAll.title")

  return (
    <div className="dropdown dropdown-end">
      <Button
        variant="primary"
        size="sm"
        loading={busy}
        loadingLabel={t("submissions.menu.actions")}
      >
        {busy
          ? collecting
            ? t("submissions.collect.active")
            : t("submissions.regradeAll.active")
          : t("submissions.menu.actions")}
        {!busy && <TriangleDownIcon aria-hidden="true" className="size-4" />}
      </Button>
      <DropdownMenu className="w-64">
        {/* Metrics — graded-snapshot stats; hidden in live view (onMetrics
            omitted there). */}
        {onMetrics && (
          <li>
            <button
              type="button"
              onClick={() => {
                closeMenu()
                onMetrics()
              }}
            >
              <GraphIcon aria-hidden="true" className="size-4" />
              {t("submissions.menu.metrics")}
            </button>
          </li>
        )}
        {onMetrics && (
          <div
            className="my-1 border-t border-base-content/10"
            role="separator"
          />
        )}
        {/* Open all Feedback PRs — the bulk PR action leads the menu. The page
            owns the gate (owner-only, non-empty_repo): a no_autograder repo is
            templated and PERMITS the PR, so no skipsGrading re-gate here. */}
        {onOpenAllPrs && (
          <>
            <li>
              <button
                type="button"
                disabled={disabledActions}
                title={
                  emptyRoster
                    ? t("submissions.openAllPrs.titleEmptyRoster")
                    : t("submissions.openAllPrs.title")
                }
                onClick={() => {
                  closeMenu()
                  if (disabledActions) return
                  onOpenAllPrs()
                }}
              >
                <GitPullRequestIcon aria-hidden="true" className="size-4" />
                {t("submissions.openAllPrs.menuLabel")}
              </button>
            </li>
            <div
              className="my-1 border-t border-base-content/10"
              role="separator"
            />
          </>
        )}
        {/* Collect stays for non-autograding assignments: it's org-wide and
            collect_scores.py skips this assignment server-side (see the
            SubmissionsPage comment). Only grading actions hide. */}
        <li>
          <button
            type="button"
            disabled={disabledActions}
            title={collectTitle}
            onClick={() => {
              closeMenu()
              if (disabledActions) return
              onCollect()
            }}
          >
            <DownloadIcon aria-hidden="true" className="size-4" />
            {collecting
              ? t("submissions.collect.active")
              : t("submissions.collect.label")}
          </button>
        </li>
        {!skipsGrading && (
          <>
            {canRegradeAll && (
              <li>
                <button
                  type="button"
                  disabled={disabledActions}
                  title={regradeTitle}
                  onClick={() => {
                    closeMenu()
                    if (disabledActions) return
                    onRegradeAll()
                  }}
                >
                  <SyncIcon
                    aria-hidden="true"
                    className={`size-4 ${regradeAllActive ? "animate-spin" : ""}`}
                  />
                  {regradeAllActive
                    ? t("submissions.regradeAll.active")
                    : t("submissions.regradeAll.label")}
                </button>
              </li>
            )}
            <li>
              <a href={viewHref} target="_blank" rel="noreferrer">
                <LinkExternalIcon aria-hidden="true" className="size-4" />
                {viewLabel}
              </a>
            </li>
          </>
        )}
        <div
          className="my-1 border-t border-base-content/10"
          role="separator"
        />
        {/* Update student repo access — an authoring-tier action, grouped with
            Lock/Unlock above the CSV export. */}
        {onBulkAccess && (
          <>
            <li>
              <button
                type="button"
                disabled={disabledActions}
                title={
                  emptyRoster
                    ? t("submissions.bulkAccess.titleEmptyRoster")
                    : t("submissions.bulkAccess.menuTitle")
                }
                onClick={() => {
                  closeMenu()
                  if (disabledActions) return
                  onBulkAccess()
                }}
              >
                <ShieldCheckIcon aria-hidden="true" className="size-4" />
                {t("submissions.bulkAccess.menuLabel")}
              </button>
            </li>
            {onBulkFeatures && (
              <li>
                <button
                  type="button"
                  disabled={disabledActions}
                  title={
                    emptyRoster
                      ? t("submissions.bulkFeatures.titleEmptyRoster")
                      : t("submissions.bulkFeatures.menuTitle")
                  }
                  onClick={() => {
                    closeMenu()
                    if (disabledActions) return
                    onBulkFeatures()
                  }}
                >
                  <SlidersIcon aria-hidden="true" className="size-4" />
                  {t("submissions.bulkFeatures.menuLabel")}
                </button>
              </li>
            )}
            {onBulkVisibility && (
              <li>
                <button
                  type="button"
                  disabled={disabledActions}
                  title={
                    emptyRoster
                      ? t("submissions.bulkVisibility.titleEmptyRoster")
                      : t("submissions.bulkVisibility.menuTitle")
                  }
                  onClick={() => {
                    closeMenu()
                    if (disabledActions) return
                    onBulkVisibility()
                  }}
                >
                  <GlobeIcon aria-hidden="true" className="size-4" />
                  {t("submissions.bulkVisibility.menuLabel")}
                </button>
              </li>
            )}
            <div
              className="my-1 border-t border-base-content/10"
              role="separator"
            />
          </>
        )}
        {/* Update autograding triggers — retrofits each repo's shim to the
            assignment's submission_mode. Gated independently of bulk access
            (also requires the default autograder), but same authoring tier. */}
        {onBulkTrigger && (
          <>
            <li>
              <button
                type="button"
                disabled={disabledActions}
                title={
                  emptyRoster
                    ? t("submissions.bulkTrigger.titleEmptyRoster")
                    : t("submissions.bulkTrigger.menuTitle")
                }
                onClick={() => {
                  closeMenu()
                  if (disabledActions) return
                  onBulkTrigger()
                }}
              >
                <GitBranchIcon aria-hidden="true" className="size-4" />
                {t("submissions.bulkTrigger.menuLabel")}
              </button>
            </li>
            <div
              className="my-1 border-t border-base-content/10"
              role="separator"
            />
          </>
        )}
        {/* Pause / Resume autograding — disables/enables each repo's autograde
            workflow via the GitHub Actions state (no file edit). Same authoring
            tier + default-autograder gate as the trigger retrofit. */}
        {(onBulkPause || onBulkResume) && (
          <>
            {onBulkPause && (
              <li>
                <button
                  type="button"
                  disabled={disabledActions}
                  title={
                    emptyRoster
                      ? t("submissions.bulkAutograde.pauseTitleEmptyRoster")
                      : t("submissions.bulkAutograde.pauseMenuTitle")
                  }
                  onClick={() => {
                    closeMenu()
                    if (disabledActions) return
                    onBulkPause()
                  }}
                >
                  <PauseIcon aria-hidden="true" className="size-4" />
                  {t("submissions.bulkAutograde.pauseMenuLabel")}
                </button>
              </li>
            )}
            {onBulkResume && (
              <li>
                <button
                  type="button"
                  disabled={disabledActions}
                  title={
                    emptyRoster
                      ? t("submissions.bulkAutograde.resumeTitleEmptyRoster")
                      : t("submissions.bulkAutograde.resumeMenuTitle")
                  }
                  onClick={() => {
                    closeMenu()
                    if (disabledActions) return
                    onBulkResume()
                  }}
                >
                  <PlayIcon aria-hidden="true" className="size-4" />
                  {t("submissions.bulkAutograde.resumeMenuLabel")}
                </button>
              </li>
            )}
            <div
              className="my-1 border-t border-base-content/10"
              role="separator"
            />
          </>
        )}
        {/* Close / Reopen submission — ends or reopens the submission window
            (blocks new accepts + sets repos read-only on close). Same
            authoring tier + per-repo bulk-access gate; independent of Lock. */}
        {onCloseToggle && (
          <>
            <li>
              <button
                type="button"
                disabled={disabledActions}
                title={
                  closed
                    ? t("submissions.closeSubmission.reopenMenuTitle")
                    : t("submissions.closeSubmission.menuTitle")
                }
                onClick={() => {
                  closeMenu()
                  if (disabledActions) return
                  onCloseToggle()
                }}
              >
                <CalendarIcon aria-hidden="true" className="size-4" />
                {closed
                  ? t("submissions.closeSubmission.reopenLabel")
                  : t("submissions.closeSubmission.menuLabel")}
              </button>
            </li>
            <div
              className="my-1 border-t border-base-content/10"
              role="separator"
            />
          </>
        )}
        {/* Lock / Unlock — an assignment-lifecycle action (teacher|hta), so the
            page omits onLockToggle for a viewer who can't author. Its own group,
            above the CSV export. */}
        {onLockToggle && (
          <>
            <li>
              <button
                type="button"
                disabled={lockPending}
                title={
                  locked
                    ? t("submissions.lock.unlockTitle")
                    : t("submissions.lock.lockTitle")
                }
                onClick={() => {
                  closeMenu()
                  if (lockPending) return
                  onLockToggle()
                }}
              >
                {locked ? (
                  <UnlockIcon aria-hidden="true" className="size-4" />
                ) : (
                  <LockIcon aria-hidden="true" className="size-4" />
                )}
                {locked
                  ? t("submissions.lock.unlockLabel")
                  : t("submissions.lock.lockLabel")}
              </button>
            </li>
            <div
              className="my-1 border-t border-base-content/10"
              role="separator"
            />
          </>
        )}
        <li>
          <button
            type="button"
            disabled={downloadDisabled}
            onClick={() => {
              closeMenu()
              if (downloadDisabled) return
              onDownloadCsv()
            }}
          >
            <DownloadIcon aria-hidden="true" className="size-4" />
            {t("submissions.downloadCsv")}
          </button>
        </li>
        <li>
          <button
            type="button"
            disabled={downloadAllDisabled}
            title={
              downloadAllDisabled
                ? t("submissions.downloadAll.titleDisabled")
                : t("submissions.downloadAll.title")
            }
            onClick={() => {
              closeMenu()
              if (downloadAllDisabled) return
              onDownloadAll()
            }}
          >
            <FileZipIcon aria-hidden="true" className="size-4" />
            {t("submissions.downloadAll.menuLabel")}
          </button>
        </li>
        {/* Delete assignment — destructive, so deliberately last and in its
            own group. */}
        {onDelete && (
          <>
            <div
              className="my-1 border-t border-base-content/10"
              role="separator"
            />
            <li>
              <button
                type="button"
                className="text-error"
                title={t("submissions.deleteAssignment.menuTitle")}
                onClick={() => {
                  closeMenu()
                  onDelete()
                }}
              >
                <TrashIcon aria-hidden="true" className="size-4" />
                {t("submissions.deleteAssignment.menuLabel")}
              </button>
            </li>
          </>
        )}
      </DropdownMenu>
    </div>
  )
}

export default SubmissionsActionsMenu
