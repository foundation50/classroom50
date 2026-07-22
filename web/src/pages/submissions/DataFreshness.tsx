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
  // Whether the viewer can use live at all (org owner, autograded assignment).
  // When true the mode is a switch; when false it's a non-interactive Static
  // chip (a TA/HTA can't fan out, so there's nothing to toggle).
  liveCapable?: boolean
  onViewModeChange?: (mode: "live" | "static") => void
  // empty_repo assignments never autograde; show that instead of freshness.
  emptyRepo?: boolean
}

export function DataFreshness({
  mode,
  lastCollectedLabel,
  fetching,
  errorCount,
  onRefresh,
  liveCapable = false,
  onViewModeChange,
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
    <div className="flex flex-col items-start gap-1 text-sm text-base-content/70">
      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-1"
        role="status"
      >
        {/* Mode control on the left: an interactive switch (label = the live/
            static word, green when live) when the viewer can go live, else a
            non-interactive Static chip. Merges the old separate "Live View"
            toggle and the mode chip into one control. */}
        {liveCapable && onViewModeChange ? (
          <label
            className="flex cursor-pointer items-center gap-2 font-medium"
            title={
              isLive
                ? t("submissions.freshness.liveHelp")
                : t("submissions.freshness.staticHelp")
            }
          >
            <input
              type="checkbox"
              className="toggle toggle-sm toggle-success"
              checked={isLive}
              onChange={(e) =>
                onViewModeChange(e.target.checked ? "live" : "static")
              }
            />
            <span className={cx(isLive && "text-success")}>
              {isLive
                ? t("submissions.freshness.liveChip")
                : t("submissions.freshness.staticChip")}
            </span>
          </label>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-base-content/10 px-2 py-0.5 text-xs font-medium text-base-content/70">
            <span
              className="size-1.5 rounded-full bg-base-content/40"
              aria-hidden="true"
            />
            {t("submissions.freshness.staticChip")}
          </span>
        )}

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
