import { SyncIcon } from "@/components/ui/icons"
import { useTranslation } from "react-i18next"

import { Alert, Badge, Button, cx } from "@/components/ui"

// One passive freshness surface for the submissions dashboard. The table always
// shows the collected scores.json snapshot; this line states when the submission
// data was last collected and offers a single re-collect button. When an
// assignment repo has been pushed since the last collect (staleness derived from
// the org repo list's `pushed_at` — no extra fetch, so it works for every
// viewer, not just owners), a warning "Out of date" badge joins the line.
// Following data-freshness UX guidance: never let stale data look
// authoritative, and give the user a direct way to refresh it.
//
// The button reads "Collect now" in every state — the same string the Manage
// hub's collect action uses, because it is the same dispatch. Staleness is
// carried by the badge, not by the button's variant: the collect is additive
// and re-runnable, so a danger-toned button would promise a destructive action
// it doesn't perform.
//
// A bare empty_repo assignment has no collect at all — the page omits this
// component and the header's grading badge explains why. A no_autograder
// assignment IS collected (its submissions are detected rather than graded), so
// it keeps this surface.
export type DataFreshnessProps = {
  // Relative "x ago" of the last completed collect run — when the submission
  // data was produced org-wide. Null when never collected.
  lastCollectedLabel: string | null
  // An assignment repo was pushed after the last collect, so the snapshot is
  // (probably) out of date — surfaces the "Out of date" badge.
  stale: boolean
  // A collect is in flight (dispatching/running) — disables the button and spins.
  collecting: boolean
  // Trigger a Collect Scores run to rebuild scores.json. Omitted when the
  // viewer can't collect (e.g., empty roster) — then no button renders.
  onRefresh?: () => void
  // Repos the live fan-out couldn't read (owner only); > 0 shows a warning so
  // an incomplete live status doesn't look authoritative.
  errorCount?: number
}

export function DataFreshness({
  lastCollectedLabel,
  stale,
  collecting,
  onRefresh,
  errorCount = 0,
}: DataFreshnessProps) {
  const { t } = useTranslation()

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

        {/* Stale carries its own chip so the out-of-date state is legible
            without recolouring the action beside it. */}
        {stale && (
          <Badge tone="warning" title={t("submissions.freshness.staleHelp")}>
            {t("submissions.freshness.stale")}
          </Badge>
        )}

        {onRefresh && (
          // A quiet ghost button in both states, so the freshness line doesn't
          // outshout the search/filter controls beside it in the toolbar.
          <Button
            variant="ghost"
            size="sm"
            disabled={collecting}
            onClick={onRefresh}
            aria-live="polite"
            className="text-base-content/70"
            title={
              stale
                ? t("submissions.freshness.staleHelp")
                : t("submissions.freshness.collectHelp")
            }
          >
            <SyncIcon
              aria-hidden="true"
              className={cx("size-4", collecting && "animate-spin")}
            />
            {collecting
              ? t("submissions.collect.active")
              : t("submissions.collect.label")}
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
