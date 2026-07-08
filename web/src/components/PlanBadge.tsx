import GitHub from "@/assets/github.svg?react"
import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui"

// Shared GitHub-plan badge (org's billing plan). GitHub returns the plan name
// only to org owners, so callers pass `undefined` for non-owners and nothing
// renders. The GitHub mark signals this is the org's GitHub plan, not a
// Classroom 50 state.
const PlanBadge = ({
  name,
  title,
  className = "",
}: {
  name?: string
  title?: string
  className?: string
}) => {
  const { t } = useTranslation()
  if (!name) return null

  return (
    <Badge
      ghost
      className={`gap-1 capitalize ${className}`.trim()}
      title={title}
    >
      <GitHub className="size-3" aria-hidden="true" />
      {t("components.planBadge.label", { name })}
    </Badge>
  )
}

export default PlanBadge
