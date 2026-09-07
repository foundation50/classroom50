import { SyncIcon } from "@/components/ui/icons"
import { useTranslation } from "react-i18next"

import { Alert, Button } from "@/components/ui"
import { SubmissionFreshnessLine } from "@/components/SubmissionFreshnessLine"

// The submissions dashboard's freshness surface: the shared freshness strip
// (last collected + "Out of date" badge, see SubmissionFreshnessLine) carrying
// this page's per-assignment collect, plus the degraded-read warning that only
// this page can raise.
//
// The table always shows the collected scores.json snapshot. Staleness comes
// from the org repo list's `pushed_at` — no extra fetch, so it works for every
// viewer, not just owners. Following data-freshness UX guidance: never let
// stale data look authoritative, and give the user a direct way to refresh it.
//
// For a viewer who can dispatch the collect (teacher, head TA) the button reads
// "Collect now" (and "Collecting…" while the run is in flight) — the same
// strings the Manage hub's collect action uses, because it is the same dispatch. A TA has read-only config-repo access
// and can't dispatch, so their button is "Refresh" (re-read what a teacher
// collected) with a note on who to ask.
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
  // A collect is in flight (dispatching/running). The button becomes the
  // in-page progress indicator: it spins, reads "Collecting…", and goes inert
  // (but stays focusable) until the run settles.
  collecting: boolean
  // The read-only Refresh variant's re-reads are in flight. Same treatment as
  // `collecting`, reading "Refreshing…": a TA gets feedback for the click even
  // though no workflow phase changes for them.
  refreshing?: boolean
  // Collect (canCollect) or re-read (otherwise) the submission data. Omitted
  // when neither applies (e.g., empty roster) — then no button renders.
  onRefresh?: () => void
  // Whether the viewer can dispatch the collect workflow (config-repo write).
  // False renders the read-only Refresh variant and the ask-a-teacher note.
  canCollect?: boolean
  // Repos the live fan-out couldn't read; > 0 shows a warning so an incomplete
  // live status doesn't look authoritative.
  errorCount?: number
}

export function DataFreshness({
  lastCollectedLabel,
  stale,
  collecting,
  refreshing = false,
  onRefresh,
  canCollect = true,
  errorCount = 0,
}: DataFreshnessProps) {
  const { t } = useTranslation()
  const busy = collecting || refreshing

  return (
    <div className="flex flex-col items-start gap-1">
      <SubmissionFreshnessLine
        lastCollectedLabel={lastCollectedLabel}
        stale={stale}
      >
        {onRefresh && (
          // A quiet ghost button in both states, so the freshness line doesn't
          // outshout the search/filter controls beside it in the toolbar.
          // `loading` swallows clicks and `busyLabel` is the in-place progress
          // text, so no `disabled` (which would drop keyboard focus mid-action).
          <Button
            variant="ghost"
            size="sm"
            loading={busy}
            busyLabel={
              collecting
                ? t("submissions.collect.active")
                : t("submissions.freshness.refreshing")
            }
            onClick={onRefresh}
            className="text-base-content/70"
            title={
              canCollect
                ? t("submissions.freshness.collectHelp")
                : t("submissions.freshness.refreshHelp")
            }
          >
            <SyncIcon aria-hidden="true" className="size-4" />
            {canCollect
              ? t("submissions.collect.label")
              : t("submissions.freshness.refreshLabel")}
          </Button>
        )}
      </SubmissionFreshnessLine>

      {/* A TA can't rebuild the data themselves: say who can, so a stale
          snapshot has a next step rather than a dead end. */}
      {!canCollect && (
        <p className="text-xs text-base-content/60">
          {t("submissions.freshness.collectRestricted")}
        </p>
      )}

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
