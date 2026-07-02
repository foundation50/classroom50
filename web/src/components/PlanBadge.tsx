import GitHub from "@/assets/github.svg?react"
import { useTranslation } from "react-i18next"

// Shared GitHub-plan badge (org's billing plan). GitHub only returns the plan
// name to org owners, so callers pass `undefined` for non-owners and nothing
// renders. The GitHub mark signals this reflects the org's GitHub plan, not a
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
    <span
      className={`badge badge-ghost badge-sm gap-1 capitalize ${className}`.trim()}
      title={title}
    >
      <GitHub className="size-3" aria-hidden="true" />
      {t("components.planBadge.label", { name })}
    </span>
  )
}

export default PlanBadge
