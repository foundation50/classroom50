import { Info, RefreshCw } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Alert, Button, cx } from "@/components/ui"

// One passive freshness surface for the submissions dashboard. The table always
// shows the collected scores.json snapshot; this line states when the submission
// data was last collected and offers a single re-collect button. When an
// assignment repo has been pushed since the last collect (staleness derived from
// the org repo list's `pushed_at` — no extra fetch, so it works for every
// viewer, not just owners), the button turns red (error) and reads "Sync now"
// to flag that the snapshot is out of date; otherwise it's a quiet "Refresh
// submissions". Following data-freshness UX guidance: never let
// stale data look authoritative, and give the user a direct way to refresh it.
export type DataFreshnessProps = {
  // Relative "x ago" of the last completed collect run — when the submission
  // data was produced org-wide. Null when never collected.
  lastCollectedLabel: string | null
  // An assignment repo was pushed after the last collect, so the snapshot is
  // (probably) out of date — turns the button into the warning "Sync now" CTA.
  stale: boolean
  // A collect is in flight (dispatching/running) — disables the button and spins.
  collecting: boolean
  // Trigger a Collect Scores run to rebuild scores.json. Omitted when the
  // viewer can't collect (e.g. empty roster) — then no button renders.
  onRefresh?: () => void
  // Repos the live fan-out couldn't read (owner only); > 0 shows a warning so
  // an incomplete live status doesn't look authoritative.
  errorCount?: number
  // empty_repo assignments never autograde; show that instead of freshness.
  emptyRepo?: boolean
}

export function DataFreshness({
  lastCollectedLabel,
  stale,
  collecting,
  onRefresh,
  errorCount = 0,
  emptyRepo = false,
}: DataFreshnessProps) {
  const { t } = useTranslation()

  if (emptyRepo) {
    return (
      <div className="flex items-start gap-2 text-sm text-base-content/70">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p>{t("submissions.emptyRepoNote")}</p>
      </div>
    )
  }

  const collectedLine = lastCollectedLabel
    ? t("submissions.freshness.collected", { when: lastCollectedLabel })
    : t("submissions.freshness.neverCollected")

  return (
    <div className="flex flex-col items-start gap-1">
      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-base-content/70"
        role="status"
      >
        <span>{collectedLine}</span>

        {onRefresh && (
          // Stale: a red "Sync now" flags the out-of-date snapshot and
          // re-collects on click. In sync: a quiet ghost "Refresh".
          <Button
            variant={stale ? "error" : "ghost"}
            size="xs"
            disabled={collecting}
            onClick={onRefresh}
            aria-live="polite"
            title={
              stale
                ? t("submissions.freshness.syncHelp")
                : t("submissions.freshness.refreshHelp")
            }
          >
            <RefreshCw
              aria-hidden="true"
              size={12}
              className={cx("me-1", collecting && "animate-spin")}
            />
            {collecting
              ? t("submissions.freshness.refreshing")
              : stale
                ? t("submissions.freshness.sync")
                : t("submissions.freshness.refresh")}
          </Button>
        )}
      </div>

      {/* Degraded live read: some repos couldn't be read, so live status is
          provisional. Say so rather than showing an incomplete view as
          authoritative. */}
      {errorCount > 0 && (
        <Alert tone="warning" role="status">
          {t("submissions.live.incomplete", { count: errorCount })}
        </Alert>
      )}
    </div>
  )
}

export default DataFreshness
