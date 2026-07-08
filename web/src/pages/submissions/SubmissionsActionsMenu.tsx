import {
  ChevronDown,
  DownloadCloud,
  ExternalLink,
  FileDown,
  RefreshCw,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui"

// Consolidates the workflow actions (Collect now / Regrade all / View workflow)
// plus the CSV export into one dropdown so the toolbar stays compact and the
// roster surfaces higher. daisyUI dropdowns are focus-driven; selecting an item
// blurs to close. Disabled/loading gating mirrors the former inline buttons.
export function SubmissionsActionsMenu({
  collecting,
  regrading,
  regradeAllActive,
  emptyRoster,
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
  emptyRoster: boolean
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
