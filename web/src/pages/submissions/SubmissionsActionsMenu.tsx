import {
  BarChart3,
  ChevronDown,
  DownloadCloud,
  ExternalLink,
  FileArchive,
  FileDown,
  GitPullRequest,
  Lock,
  LockOpen,
  RefreshCw,
  ShieldCheck,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui"

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
  emptyRepo = false,
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
  locked = false,
  lockPending = false,
  onLockToggle,
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
  // empty_repo assignment: never autogrades, so the grading actions (Collect
  // now / Regrade all / View workflow) are hidden — only the CSV export stays.
  emptyRepo?: boolean
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
  // Current locked state, for the Lock/Unlock item's label and icon.
  locked?: boolean
  // Whether a lock/unlock is mid-flight, to disable the item and show progress.
  lockPending?: boolean
  // Opens the lock/unlock confirmation. Omitted (item hidden) when the viewer
  // can't author assignments (teacher|hta) — the page owns the mutation, this
  // is just the affordance.
  onLockToggle?: () => void
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
        {!busy && <ChevronDown aria-hidden="true" className="size-4" />}
      </Button>
      <ul
        tabIndex={0}
        className="dropdown-content menu z-10 mt-1 w-64 rounded-box border border-base-content/5 bg-base-100 p-1 shadow"
      >
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
              <BarChart3 aria-hidden="true" className="size-4" />
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
        {/* Open all Feedback PRs — the bulk PR action leads the menu. Its own
            group (owner-only, non-empty_repo), above the grading actions. */}
        {!emptyRepo && onOpenAllPrs && (
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
                <GitPullRequest aria-hidden="true" className="size-4" />
                {t("submissions.openAllPrs.menuLabel")}
              </button>
            </li>
            <div
              className="my-1 border-t border-base-content/10"
              role="separator"
            />
          </>
        )}
        {/* Collect stays for empty_repo assignments: it's org-wide and
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
            <DownloadCloud aria-hidden="true" className="size-4" />
            {collecting
              ? t("submissions.collect.active")
              : t("submissions.collect.label")}
          </button>
        </li>
        {!emptyRepo && (
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
                  <RefreshCw
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
                <ExternalLink aria-hidden="true" className="size-4" />
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
                <ShieldCheck aria-hidden="true" className="size-4" />
                {t("submissions.bulkAccess.menuLabel")}
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
                  <LockOpen aria-hidden="true" className="size-4" />
                ) : (
                  <Lock aria-hidden="true" className="size-4" />
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
            <FileDown aria-hidden="true" className="size-4" />
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
            <FileArchive aria-hidden="true" className="size-4" />
            {t("submissions.downloadAll.menuLabel")}
          </button>
        </li>
      </ul>
    </div>
  )
}

export default SubmissionsActionsMenu
