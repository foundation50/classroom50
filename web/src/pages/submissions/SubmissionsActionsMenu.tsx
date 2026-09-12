import {
  BrowserIcon,
  CalendarIcon,
  TriangleDownIcon,
  DownloadIcon,
  FileZipIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  GlobeIcon,
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
  onBulkPages,
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
  // Whether the viewer may trigger "Regrade all" (teacher|hta). Workflow
  // dispatch needs config-repo write, which a pull-only TA lacks; GitHub 403s
  // them regardless, so this is the UX gate. Defaults true for callers that
  // don't gate (the item stays visible).
  canRegradeAll?: boolean
  emptyRoster: boolean
  // The assignment never autogrades (empty_repo OR no_autograder), so the
  // grading actions (Regrade all / View workflow) are hidden — Collect and the
  // exports stay.
  skipsGrading?: boolean
  // Dispatches a collect. Omitted (hidden) for a viewer who can't dispatch
  // workflows in the config repo (a TA); they refresh from the toolbar instead.
  onCollect?: () => void
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
  // Opens the whole-assignment "Enable GitHub Pages" modal. Same gate as
  // onBulkFeatures plus an assignment with a pages block; omitted otherwise.
  onBulkPages?: () => void
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
      {/* The trigger spins only for the action it owns (Regrade all). A
          collect is indicated by the toolbar's Collect now button, so the
          menu stays open for business (exports, View run) meanwhile; its
          workflow items are still gated via disabledActions. */}
      <Button
        variant="primary"
        size="sm"
        loading={regrading}
        loadingLabel={t("submissions.regradeAll.active")}
      >
        {regrading
          ? t("submissions.regradeAll.active")
          : t("submissions.menu.actions")}
        {!regrading && (
          <TriangleDownIcon aria-hidden="true" className="size-4" />
        )}
      </Button>
      <DropdownMenu className="w-64">
        {/* Open all Feedback PRs leads the menu. The page owns the gate
            (owner-only, non-empty_repo): a no_autograder repo is initialized and
            PERMITS the PR, so no skipsGrading re-gate here. */}
        {onOpenAllPrs && (
          <>
            <DropdownMenu.Item
              icon={GitPullRequestIcon}
              label={t("submissions.openAllPrs.menuLabel")}
              disabled={disabledActions}
              title={
                emptyRoster
                  ? t("submissions.openAllPrs.titleEmptyRoster")
                  : t("submissions.openAllPrs.title")
              }
              onSelect={onOpenAllPrs}
            />
            <DropdownMenu.Separator />
          </>
        )}
        {/* Collect stays for non-autograding assignments: it's org-wide and
            collect_scores.py skips this assignment server-side (see the
            SubmissionsPage comment). Only grading actions hide. Omitted for a
            viewer who can't dispatch the workflow (a pull-only TA). */}
        {onCollect && (
          <DropdownMenu.Item
            icon={DownloadIcon}
            label={
              collecting
                ? t("submissions.collect.active")
                : t("submissions.collect.label")
            }
            disabled={disabledActions}
            title={collectTitle}
            onSelect={onCollect}
          />
        )}
        {!skipsGrading && (
          <>
            {canRegradeAll && (
              <DropdownMenu.Item
                icon={SyncIcon}
                iconClassName={regradeAllActive ? "animate-spin" : undefined}
                label={
                  regradeAllActive
                    ? t("submissions.regradeAll.active")
                    : t("submissions.regradeAll.label")
                }
                disabled={disabledActions}
                title={regradeTitle}
                onSelect={onRegradeAll}
              />
            )}
            <DropdownMenu.LinkItem
              icon={LinkExternalIcon}
              label={viewLabel}
              href={viewHref}
            />
          </>
        )}
        <DropdownMenu.Separator />
        {/* Update student repo access: an authoring-tier action, grouped with
            Lock/Unlock above the CSV export. */}
        {onBulkAccess && (
          <>
            <DropdownMenu.Item
              icon={ShieldCheckIcon}
              label={t("submissions.bulkAccess.menuLabel")}
              disabled={disabledActions}
              title={
                emptyRoster
                  ? t("submissions.bulkAccess.titleEmptyRoster")
                  : t("submissions.bulkAccess.menuTitle")
              }
              onSelect={onBulkAccess}
            />
            {onBulkFeatures && (
              <DropdownMenu.Item
                icon={SlidersIcon}
                label={t("submissions.bulkFeatures.menuLabel")}
                disabled={disabledActions}
                title={
                  emptyRoster
                    ? t("submissions.bulkFeatures.titleEmptyRoster")
                    : t("submissions.bulkFeatures.menuTitle")
                }
                onSelect={onBulkFeatures}
              />
            )}
            {onBulkVisibility && (
              <DropdownMenu.Item
                icon={GlobeIcon}
                label={t("submissions.bulkVisibility.menuLabel")}
                disabled={disabledActions}
                title={
                  emptyRoster
                    ? t("submissions.bulkVisibility.titleEmptyRoster")
                    : t("submissions.bulkVisibility.menuTitle")
                }
                onSelect={onBulkVisibility}
              />
            )}
            {onBulkPages && (
              <DropdownMenu.Item
                icon={BrowserIcon}
                label={t("submissions.bulkPages.menuLabel")}
                disabled={disabledActions}
                title={
                  emptyRoster
                    ? t("submissions.bulkPages.titleEmptyRoster")
                    : t("submissions.bulkPages.menuTitle")
                }
                onSelect={onBulkPages}
              />
            )}
            <DropdownMenu.Separator />
          </>
        )}
        {/* Update autograding triggers: retrofits each repo's shim to the
            assignment's submission_mode. Gated independently of bulk access
            (also requires the default autograder), but same authoring tier. */}
        {onBulkTrigger && (
          <>
            <DropdownMenu.Item
              icon={GitBranchIcon}
              label={t("submissions.bulkTrigger.menuLabel")}
              disabled={disabledActions}
              title={
                emptyRoster
                  ? t("submissions.bulkTrigger.titleEmptyRoster")
                  : t("submissions.bulkTrigger.menuTitle")
              }
              onSelect={onBulkTrigger}
            />
            <DropdownMenu.Separator />
          </>
        )}
        {/* Pause / Resume autograding: disables/enables each repo's autograde
            workflow via the GitHub Actions state (no file edit). Same authoring
            tier + default-autograder gate as the trigger retrofit. */}
        {(onBulkPause || onBulkResume) && (
          <>
            {onBulkPause && (
              <DropdownMenu.Item
                icon={PauseIcon}
                label={t("submissions.bulkAutograde.pauseMenuLabel")}
                disabled={disabledActions}
                title={
                  emptyRoster
                    ? t("submissions.bulkAutograde.pauseTitleEmptyRoster")
                    : t("submissions.bulkAutograde.pauseMenuTitle")
                }
                onSelect={onBulkPause}
              />
            )}
            {onBulkResume && (
              <DropdownMenu.Item
                icon={PlayIcon}
                label={t("submissions.bulkAutograde.resumeMenuLabel")}
                disabled={disabledActions}
                title={
                  emptyRoster
                    ? t("submissions.bulkAutograde.resumeTitleEmptyRoster")
                    : t("submissions.bulkAutograde.resumeMenuTitle")
                }
                onSelect={onBulkResume}
              />
            )}
            <DropdownMenu.Separator />
          </>
        )}
        {/* Close / Reopen submission: ends or reopens the submission window
            (blocks new accepts + sets repos read-only on close). Same
            authoring tier + per-repo bulk-access gate; independent of Lock. */}
        {onCloseToggle && (
          <>
            <DropdownMenu.Item
              icon={CalendarIcon}
              label={
                closed
                  ? t("submissions.closeSubmission.reopenLabel")
                  : t("submissions.closeSubmission.menuLabel")
              }
              disabled={disabledActions}
              title={
                closed
                  ? t("submissions.closeSubmission.reopenMenuTitle")
                  : t("submissions.closeSubmission.menuTitle")
              }
              onSelect={onCloseToggle}
            />
            <DropdownMenu.Separator />
          </>
        )}
        {/* Lock / Unlock: an assignment-lifecycle action (teacher|hta), so the
            page omits onLockToggle for a viewer who can't author. Its own group,
            above the CSV export. */}
        {onLockToggle && (
          <>
            <DropdownMenu.Item
              icon={locked ? UnlockIcon : LockIcon}
              label={
                locked
                  ? t("submissions.lock.unlockLabel")
                  : t("submissions.lock.lockLabel")
              }
              disabled={lockPending}
              title={
                locked
                  ? t("submissions.lock.unlockTitle")
                  : t("submissions.lock.lockTitle")
              }
              onSelect={onLockToggle}
            />
            <DropdownMenu.Separator />
          </>
        )}
        <DropdownMenu.Item
          icon={DownloadIcon}
          label={t("submissions.downloadCsv")}
          disabled={downloadDisabled}
          onSelect={onDownloadCsv}
        />
        <DropdownMenu.Item
          icon={FileZipIcon}
          label={t("submissions.downloadAll.menuLabel")}
          disabled={downloadAllDisabled}
          title={
            downloadAllDisabled
              ? t("submissions.downloadAll.titleDisabled")
              : t("submissions.downloadAll.title")
          }
          onSelect={onDownloadAll}
        />
        {/* Delete assignment: destructive, so deliberately last and in its
            own group. */}
        {onDelete && (
          <>
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              icon={TrashIcon}
              label={t("submissions.deleteAssignment.menuLabel")}
              title={t("submissions.deleteAssignment.menuTitle")}
              destructive
              onSelect={onDelete}
            />
          </>
        )}
      </DropdownMenu>
    </div>
  )
}

export default SubmissionsActionsMenu
