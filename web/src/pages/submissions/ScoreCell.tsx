import { Pencil } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Badge, Button } from "@/components/ui"
import { ScoreBadge } from "@/pages/submissions/ScoreBadge"

// The idle score cell with an override trigger. Shows the current grade (or an
// ungraded affordance), a "Manual" badge when overridden, and an edit button
// that opens the score-override modal. The modal itself (and its state) lives
// in the parent table; this cell is presentational plus one onEdit callback.
export function ScoreCell({
  owner,
  hasGrade,
  score,
  max,
  overridden,
  thresholdFraction,
  onEdit,
}: {
  owner: string
  hasGrade: boolean
  score: number
  max: number
  overridden: boolean
  thresholdFraction: number | null
  onEdit: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-1.5">
      {hasGrade ? (
        <ScoreBadge
          score={score}
          max={max}
          thresholdFraction={thresholdFraction}
        />
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
      <Button
        type="button"
        variant="ghost"
        size="xs"
        shape="square"
        aria-label={
          overridden
            ? t("submissions.scoreOverride.overrideLabel", { name: owner })
            : hasGrade
              ? t("submissions.scoreOverride.editLabel", { name: owner })
              : t("submissions.scoreOverride.addLabel", { name: owner })
        }
        title={
          overridden
            ? t("submissions.scoreOverride.override")
            : hasGrade
              ? t("submissions.scoreOverride.edit")
              : t("submissions.scoreOverride.add")
        }
        onClick={onEdit}
      >
        <Pencil className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  )
}

export default ScoreCell
