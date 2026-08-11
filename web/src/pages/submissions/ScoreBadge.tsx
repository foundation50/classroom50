import { Badge } from "@/components/ui"
import { scoreTone } from "@/pages/submissions/dashboard"

// Score chip via the shared scoreTone recipe — the single source for the
// score→tone→Badge mapping (AGENTS.md "one recipe, one source"). Used by the
// submissions table, the per-attempt history timeline, and the manual-grade
// cell. success/error tone for graded rows, neutral ghost for ungraded (no
// threshold or zero/NaN max).
export const ScoreBadge = ({
  score,
  max,
  thresholdFraction,
  size,
}: {
  score: number
  max: number
  thresholdFraction: number | null
  size?: "xs" | "sm" | "md"
}) => {
  const t = scoreTone(score, max, thresholdFraction)
  return (
    <Badge
      size={size}
      ghost={"ghost" in t && t.ghost}
      tone={"tone" in t ? t.tone : "neutral"}
    >
      {score}/{max}
    </Badge>
  )
}

export default ScoreBadge
