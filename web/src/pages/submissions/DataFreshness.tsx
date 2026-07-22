import { Info, RefreshCw } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button, HelpTooltip, cx } from "@/components/ui"

// One passive freshness surface for the submissions dashboard. The table always
// shows the collected scores.json snapshot; this line states when scores were
// collected and, when an assignment repo has been pushed since that collect,
// flags the snapshot as (probably) out of date and offers a one-click re-collect
// ("Refresh submissions"). The staleness signal is derived from the org repo
// list's `pushed_at` (no extra fetch), so it works for every viewer, not just
// owners. Following data-freshness UX guidance: never let stale data look
// authoritative, and give the user a direct way to refresh it.
export type DataFreshnessProps = {
  // Relative "x ago" of the last completed collect run — when scores were
  // produced org-wide, the meaningful data age. Null when never collected.
  lastCollectedLabel: string | null
  // An assignment repo was pushed after the last collect, so the snapshot is
  // (probably) out of date. Shows the stale hint + the Refresh CTA.
  stale: boolean
  // A collect is in flight (dispatching/running) — disables the CTA and spins.
  collecting: boolean
  // Trigger a Collect Scores run to rebuild scores.json. Omitted when the
  // viewer can't collect (e.g. empty roster) — then no CTA renders.
  onRefresh?: () => void
  // empty_repo assignments never autograde; show that instead of freshness.
  emptyRepo?: boolean
}

export function DataFreshness({
  lastCollectedLabel,
  stale,
  collecting,
  onRefresh,
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
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-base-content/70"
      role="status"
    >
      <span>{collectedLine}</span>

      {/* Stale hint: an assignment repo was pushed after the last collect, so
          scores.json probably misses the newest work. Announce once so the
          teacher notices without the count noise the old nudge carried. */}
      {stale && (
        <span className="text-warning" aria-live="polite">
          {"· "}
          {t("submissions.freshness.stale")}
        </span>
      )}

      <HelpTooltip help={t("submissions.freshness.help")} />

      {onRefresh && (
        <Button
          variant={stale ? "primary" : "ghost"}
          size="xs"
          disabled={collecting}
          onClick={onRefresh}
          title={t("submissions.freshness.refreshHelp")}
        >
          <RefreshCw
            aria-hidden="true"
            size={12}
            className={cx("mr-1", collecting && "animate-spin")}
          />
          {collecting
            ? t("submissions.freshness.refreshing")
            : t("submissions.freshness.refresh")}
        </Button>
      )}
    </div>
  )
}

export default DataFreshness
