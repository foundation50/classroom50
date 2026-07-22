import { Info, RefreshCw } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Alert, Button, HelpTooltip } from "@/components/ui"

// One passive freshness surface for the submissions dashboard. There is no
// live/static mode to pick: the table always shows the collected scores.json
// snapshot (grades, sort, filters) and, for an owner, silently overlays live
// submission presence read from GitHub. Following data-freshness UX guidance,
// each value self-describes its freshness — the line states when scores were
// collected and, when the live overlay finds pushes newer than the last
// collection, nudges the owner to collect again. A degraded live read is
// surfaced rather than letting an undercount look authoritative.
export type DataFreshnessProps = {
  // Relative "x ago" of the last completed collect run — when scores were
  // produced org-wide, the meaningful data age. Null when never collected.
  lastCollectedLabel: string | null
  // A fetch (snapshot or live fan-out) is in flight — spins the refresh icon.
  fetching: boolean
  // Repos the live fan-out couldn't read (owner only); > 0 shows a warning.
  errorCount: number
  onRefresh: () => void
  // Whether the viewer gets the live overlay (org owner, autograded assignment).
  // A non-capable viewer (TA/HTA) sees only the collected line — no count, no
  // Collect affordance.
  liveCapable?: boolean
  // The live fan-out for the current page is still in flight; show a neutral
  // "checking…" hint instead of a count so it never flickers up from a false 0.
  checking?: boolean
  // Count of rows on the CURRENT page whose live presence is newer than the
  // collected snapshot (pushed-again + as-yet-uncollected submitters). Page-
  // scoped because the fan-out reads only the rendered page's repos.
  newCount?: number
  // Kick off a collection to grade the new pushes; reuses the page's Collect.
  onCollect?: () => void
  // empty_repo assignments never autograde; show that instead of freshness.
  emptyRepo?: boolean
}

export function DataFreshness({
  lastCollectedLabel,
  fetching,
  errorCount,
  onRefresh,
  liveCapable = false,
  checking = false,
  newCount = 0,
  onCollect,
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

  // Owner-only nudge, page-scoped. While the fan-out is in flight we show a
  // neutral "checking…" hint (no count) so a false 0 can't flash; once settled,
  // a positive count offers Collect, and 0 reads as "up to date".
  const showChecking = liveCapable && checking
  const showNudge = liveCapable && !checking && newCount > 0
  const showUpToDate = liveCapable && !checking && newCount === 0

  return (
    <div className="flex flex-col items-start gap-1 text-sm text-base-content/70">
      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-1"
        role="status"
      >
        <span>{collectedLine}</span>

        {showChecking && (
          <span className="text-base-content/50">
            {"· "}
            {t("submissions.freshness.checking")}
          </span>
        )}

        {/* The settled overlay result. Announce it once (aria-live polite) — the
            transient "checking…" state above is not announced. */}
        {showNudge && (
          <span className="inline-flex items-center gap-2" aria-live="polite">
            <span className="text-info">
              {"· "}
              {t("submissions.live.newOnPage", { count: newCount })}
            </span>
            {onCollect && (
              <Button variant="ghost" size="xs" onClick={onCollect}>
                {t("submissions.live.collectToGrade")}
              </Button>
            )}
          </span>
        )}

        {showUpToDate && (
          <span className="text-base-content/50" aria-live="polite">
            {"· "}
            {t("submissions.freshness.upToDate")}
          </span>
        )}

        <HelpTooltip help={t("submissions.freshness.help")} />

        <Button
          variant="ghost"
          size="xs"
          shape="circle"
          disabled={fetching}
          onClick={onRefresh}
          aria-label={t("submissions.freshness.refreshAria")}
          title={t("submissions.freshness.refresh")}
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
      {liveCapable && errorCount > 0 && (
        <Alert tone="warning" role="status">
          {t("submissions.live.incomplete", { count: errorCount })}
        </Alert>
      )}
    </div>
  )
}

export default DataFreshness
