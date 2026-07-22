import { Info, RefreshCw } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Alert, Button, HelpTooltip, cx } from "@/components/ui"

// One honest freshness surface for the submissions dashboard, replacing the
// scattered "Updated X ago" span, the collection note, and the live strip.
// Following data-freshness UX guidance: a value is a number plus when it was
// observed, so we always show the mode (Live vs Static), when the data is from,
// and a manual refresh — and when a source is degraded we say so rather than
// letting stale data look authoritative.
//
// The visible line is terse (chip + short recency); the full hybrid provenance
// ("submissions read from GitHub now, scores from the last collection" vs "the
// collected snapshot") lives in a help tooltip so the header stays lean.
export type DataFreshnessProps = {
  mode: "live" | "static"
  // Relative "x ago" of the last completed collect run — when the scores were
  // actually produced (org-wide), the meaningful data age in BOTH modes. Null
  // when the assignment has never been collected.
  lastCollectedLabel: string | null
  // A fetch (snapshot or live fan-out) is in flight — spins the refresh icon.
  fetching: boolean
  // Repos the live fan-out couldn't read (live only); > 0 shows a warning.
  errorCount: number
  onRefresh: () => void
  // empty_repo assignments never autograde; show that instead of freshness.
  emptyRepo?: boolean
}

export function DataFreshness({
  mode,
  lastCollectedLabel,
  fetching,
  errorCount,
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

  const isLive = mode === "live"

  return (
    <div className="flex flex-col gap-1 text-sm text-base-content/70">
      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-1"
        role="status"
      >
        {/* Mode chip: a filled dot for live (reading now), a hollow one for the
            static snapshot. */}
        <span
          className={cx(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
            isLive
              ? "bg-success/10 text-success"
              : "bg-base-content/10 text-base-content/70",
          )}
        >
          <span
            className={cx(
              "size-1.5 rounded-full",
              isLive ? "bg-success" : "bg-base-content/40",
            )}
            aria-hidden="true"
          />
          {isLive
            ? t("submissions.freshness.liveChip")
            : t("submissions.freshness.staticChip")}
        </span>

        {/* Terse recency line; the full provenance is in the help tooltip. Both
            modes lead with the true data age — when scores were collected — not
            the browser fetch time (which is meaningless to a teacher). */}
        <span>
          {isLive
            ? lastCollectedLabel
              ? t("submissions.freshness.liveScores", {
                  when: lastCollectedLabel,
                })
              : t("submissions.freshness.liveNoScores")
            : lastCollectedLabel
              ? t("submissions.freshness.staticCollected", {
                  when: lastCollectedLabel,
                })
              : t("submissions.freshness.staticNeverCollected")}
        </span>

        <HelpTooltip
          help={
            isLive
              ? t("submissions.freshness.liveHelp")
              : t("submissions.freshness.staticHelp")
          }
        />

        <Button
          variant="ghost"
          size="xs"
          shape="circle"
          disabled={fetching}
          onClick={onRefresh}
          aria-label={
            isLive
              ? t("submissions.freshness.refreshLive")
              : t("submissions.freshness.refreshStatic")
          }
          title={
            isLive
              ? t("submissions.freshness.refreshLive")
              : t("submissions.freshness.refreshStatic")
          }
        >
          <RefreshCw
            aria-hidden="true"
            size={12}
            className={fetching ? "animate-spin" : ""}
          />
        </Button>
      </div>

      {/* Degraded live read: some repos couldn't be read, so counts / the "not
          submitted" list are provisional. Say so rather than showing stale data
          as authoritative. */}
      {isLive && errorCount > 0 && (
        <Alert tone="warning" role="status">
          {t("submissions.live.incomplete", { count: errorCount })}
        </Alert>
      )}
    </div>
  )
}

export default DataFreshness
