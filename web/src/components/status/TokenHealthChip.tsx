import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { CircleHelp, Clock, TriangleAlert } from "lucide-react"
import type { ComponentType } from "react"

import { Badge, cx } from "@/components/ui"
import type { BadgeTone } from "@/types/badgeTone"
import type { OrgServiceTokenHealth } from "@/util/serviceTokenHealth"

// One source mapping an attention-worthy health verdict to its chip tone, icon,
// and i18n label key — shared by the org card and row so they never drift. The
// healthy "ok" verdict is intentionally absent: a token in good standing needs
// no chip (see below), so it never renders.
const HEALTH_CHIP: Record<
  Exclude<OrgServiceTokenHealth, "ok">,
  {
    tone: BadgeTone
    Icon: ComponentType<{ className?: string }>
    labelKey: string
  }
> = {
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
  expiryUntracked: {
    tone: "neutral",
    Icon: Clock,
    labelKey: "serviceTokenHealth.chip.expiryUntracked",
  },
  unknown: {
    tone: "neutral",
    Icon: CircleHelp,
    labelKey: "serviceTokenHealth.chip.unknown",
  },
}

// Whether TokenHealthChip will render anything for an entry — false only for a
// resolved, healthy "ok" token (which renders null). Callers gate the chip's
// wrapper on this so a healthy org doesn't leave an empty spacer.
export function tokenChipVisible(entry: {
  health: OrgServiceTokenHealth
  loading?: boolean
}): boolean {
  return (entry.loading ?? false) || entry.health !== "ok"
}

// A per-org service-token health chip. Rendered only for owned orgs on the home
// page; clicking deep-links into that org's Service Token settings pane
// (?focus=serviceToken) so a multi-org teacher rotates without hunting.
//
// A healthy ("ok") token renders NOTHING — re-emphasizing "all good" is noise;
// the absence of a chip is itself the healthy signal. "unknown" stays visible
// (we genuinely can't judge) but is quiet and non-actionable.
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

  if (health === "ok") return null

  const { tone, Icon, labelKey } = HEALTH_CHIP[health]
  const label = t(labelKey)

  // The chip links to the rotate flow. "unknown" isn't actionable, so render a
  // static chip; the rest are clickable to rotate.
  const actionable = health !== "unknown"

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
