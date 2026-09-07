import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui"
import { AlertIcon } from "@/components/ui/icons"
import { isGroupOverCapacity } from "@/domain/teams/groupTeams"

// Error chip for a group whose live membership exceeds max_group_size
// (#896): a student maintainer can add members on GitHub directly, past the
// cap every Classroom 50 client enforces. Renders nothing while the group is
// within the cap, so rows stay quiet in the normal case. `plain` drops the
// badge's own title + sr-only detail when an interactive parent owns the
// accessible name.
export function GroupOverCapacityBadge({
  count,
  max,
  plain = false,
}: {
  count?: number
  max?: number
  plain?: boolean
}) {
  const { t } = useTranslation()
  if (count === undefined || !isGroupOverCapacity(count, max)) return null
  const detail = t("components.groupOverCapacity.title", { count, max })
  return (
    <Badge
      tone="error"
      size="sm"
      className="whitespace-nowrap"
      title={plain ? undefined : detail}
    >
      <AlertIcon aria-hidden="true" className="size-3" />
      {t("components.groupOverCapacity.badge")}
      {!plain && <span className="sr-only">{detail}</span>}
    </Badge>
  )
}

export default GroupOverCapacityBadge
