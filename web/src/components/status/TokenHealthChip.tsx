import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { CheckCircle2, CircleHelp, Clock, TriangleAlert } from "lucide-react"
import type { ComponentType } from "react"

import { Badge, cx } from "@/components/ui"
import type { BadgeTone } from "@/types/badgeTone"
import type { OrgServiceTokenHealth } from "@/util/serviceTokenHealth"

// One source mapping a service-token health verdict to its chip tone, icon, and
// i18n label key — shared by the org card and row so they never drift.
const HEALTH_CHIP: Record<
  OrgServiceTokenHealth,
  {
    tone: BadgeTone
    Icon: ComponentType<{ className?: string }>
    labelKey: string
  }
> = {
  ok: {
    tone: "success",
    Icon: CheckCircle2,
    labelKey: "serviceTokenHealth.chip.ok",
  },
  expiringSoon: {
    tone: "warning",
    Icon: Clock,
    labelKey: "serviceTokenHealth.chip.expiringSoon",
  },
  expired: {
    tone: "error",
    Icon: TriangleAlert,
    labelKey: "serviceTokenHealth.chip.expired",
  },
  missing: {
    tone: "error",
    Icon: TriangleAlert,
    labelKey: "serviceTokenHealth.chip.missing",
  },
  collectFailing: {
    tone: "error",
    Icon: TriangleAlert,
    labelKey: "serviceTokenHealth.chip.collectFailing",
  },
  unknown: {
    tone: "neutral",
    Icon: CircleHelp,
    labelKey: "serviceTokenHealth.chip.unknown",
  },
}

// A per-org service-token health chip. Rendered only for owned orgs on the home
// page; clicking deep-links into that org's Service Token settings pane
// (?focus=serviceToken) so a multi-org teacher rotates without hunting.
// "unknown" and (optionally) "ok" are visually quiet and non-actionable.
export function TokenHealthChip({
  org,
  health,
  loading,
  className,
}: {
  org: string
  health: OrgServiceTokenHealth
  loading?: boolean
  className?: string
}) {
  const { t } = useTranslation()

  if (loading) {
    return (
      <Badge tone="neutral" size="sm" ghost className={className}>
        {t("serviceTokenHealth.chip.checking")}
      </Badge>
    )
  }

  const { tone, Icon, labelKey } = HEALTH_CHIP[health]
  const label = t(labelKey)

  // The chip links to the rotate flow. "ok"/"unknown" aren't actionable, so
  // render a static chip; the rest are clickable to rotate.
  const actionable = health !== "ok" && health !== "unknown"

  const chip = (
    <Badge tone={tone} size="sm" className={cx("gap-1", className)}>
      <Icon className="size-3" />
      {label}
    </Badge>
  )

  if (!actionable) return chip

  return (
    <Link
      to="/$org/settings"
      params={{ org }}
      search={{ focus: "serviceToken" }}
      aria-label={t("serviceTokenHealth.chip.rotateAria", { org })}
      className="no-underline"
    >
      {chip}
    </Link>
  )
}

export default TokenHealthChip
