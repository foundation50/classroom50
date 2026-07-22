import {
  BarChart3,
  ChevronDown,
  DownloadCloud,
  ExternalLink,
  FileDown,
  RefreshCw,
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
  viewHref,
  viewLabel,
  onDownloadCsv,
  downloadDisabled,
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
  viewHref: string
  viewLabel: string
  onDownloadCsv: () => void
  downloadDisabled: boolean
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
      </ul>
    </div>
  )
}

export default SubmissionsActionsMenu
