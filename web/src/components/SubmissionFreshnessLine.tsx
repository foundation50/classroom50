import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui"

// The one freshness strip both collect surfaces render: when the submission
// data was last collected, an "Out of date" badge when it has fallen behind,
// and the caller's collect action beside them.
//
// Shared because the two surfaces are meant to stay in lockstep — the
// submissions page's per-assignment DataFreshness and the assignments page's
// classroom-wide ClassroomCollectButton. They differ only in scope and in
// which action they hang here, so the wording, the tone, and the layout live
// once. `stale` is decided by the caller: per assignment on one page, across
// every assignment in the classroom on the other.
export type SubmissionFreshnessLineProps = {
  // Relative "x ago" of the last completed collect for this scope, or null
  // when nothing has been collected yet.
  lastCollectedLabel: string | null
  // The snapshot is (probably) behind — a repo was pushed after the collect
  // that last walked it.
  stale: boolean
  // Drop the collected line while its source is still loading, so it doesn't
  // flash "not collected yet" before the cached snapshot arrives. The badge
  // and the action still render.
  showCollectedLine?: boolean
  // The collect action, rendered after the badge.
  children?: ReactNode
}

export function SubmissionFreshnessLine({
  lastCollectedLabel,
  stale,
  showCollectedLine = true,
  children,
}: SubmissionFreshnessLineProps) {
  const { t } = useTranslation()

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-base-content/70"
      role="status"
    >
      {showCollectedLine && (
        <span>
          {lastCollectedLabel
            ? t("submissions.freshness.collected", { when: lastCollectedLabel })
            : t("submissions.freshness.neverCollected")}
        </span>
      )}

      {/* Staleness is a chip, never the action's tone: collecting is additive
          and re-runnable, so a danger-toned button would promise a consequence
          it doesn't have. */}
      {stale && (
        <Badge tone="warning" title={t("submissions.freshness.staleHelp")}>
          {t("submissions.freshness.stale")}
        </Badge>
      )}

      {children}
    </div>
  )
}

export default SubmissionFreshnessLine
