import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui"
import { ProvenanceBadge } from "@/components/submissions/ProvenanceBadge"
import { ScoreBadge } from "@/pages/submissions/ScoreBadge"
import type { SubmissionProvenance } from "@/types/submissionProvenance"

// The grade cluster a score cell shows: the score (or a Pending / Not graded
// affordance), the Manual badge for an override, and the Unverified mark. One
// source for both the override-capable ScoreCell and the read-only table cell,
// so a badge added to one can't be missed on the other (b0c05c9 was that miss).
export function GradeBadges({
  hasGrade,
  pending = false,
  score,
  max,
  overridden,
  provenance,
  thresholdFraction,
}: {
  hasGrade: boolean
  // Submitted but not yet collected: a Pending badge instead of "Not graded".
  pending?: boolean
  score: number
  max: number
  overridden: boolean
  provenance?: SubmissionProvenance
  thresholdFraction: number | null
}) {
  const { t } = useTranslation()
  return (
    <>
      {hasGrade ? (
        <ScoreBadge
          score={score}
          max={max}
          thresholdFraction={thresholdFraction}
        />
      ) : pending ? (
        <Badge ghost size="sm" title={t("submissions.table.pendingGradeTitle")}>
          {t("submissions.table.pendingGrade")}
        </Badge>
      ) : (
        <span className="text-sm text-base-content/50">
          {t("submissions.scoreOverride.notGraded")}
        </span>
      )}
      {hasGrade && overridden ? (
        <Badge ghost size="sm" title={t("submissions.table.overriddenTitle")}>
          {t("submissions.table.overridden")}
        </Badge>
      ) : null}
      <ProvenanceBadge provenance={provenance} />
    </>
  )
}
