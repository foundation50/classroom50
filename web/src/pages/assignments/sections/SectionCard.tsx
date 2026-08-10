import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Badge, Card } from "@/components/ui"
import type { BadgeTone } from "@/types/badgeTone"
import type { SectionStatus } from "./sectionStatus"

// The per-section status badge (R2): a teacher scans the header to see whether a
// section needs attention, holds custom config, or is untouched. "default" is
// intentionally quiet (a ghost badge) so only error/configured draw the eye.
const STATUS_TONE: Record<SectionStatus, BadgeTone> = {
  error: "error",
  configured: "info",
  default: "neutral",
}

// One card wrapper for every top-level section: a bold heading, the status
// badge, an optional description, and the section body. Keeps the five sections
// visually uniform and their status in one place.
export function SectionCard({
  title,
  status,
  description,
  children,
}: {
  title: string
  status: SectionStatus
  description?: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <Card bordered={false} className="w-full mb-6">
      <Card.Body>
        <div className="flex items-center justify-between gap-3 pb-1">
          <h3 className="text-lg font-bold">{title}</h3>
          <Badge
            tone={STATUS_TONE[status]}
            ghost={status === "default"}
            className="shrink-0"
          >
            {t(`assignments.form.sectionStatus.${status}`)}
          </Badge>
        </div>
        {description ? (
          <p className="mb-3 text-sm text-base-content/70">{description}</p>
        ) : null}
        {children}
      </Card.Body>
    </Card>
  )
}
