// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). One assignment row for the confirm
// table and the execute step board: a status badge + target name + reason.
// Mirrors the org-setup InitStep presentation.

import { useTranslation } from "react-i18next"
import { AlertCircle, ArrowRight, CheckCircle, MinusCircle } from "lucide-react"

import { Badge, Spinner, type BadgeTone } from "@/components/ui"
import type {
  MigrationItemAction,
  MigrationItemStatus,
  MigrationReason,
} from "@/migration/types"

// The union of preflight actions and execute statuses this card can render.
export type ItemVisualStatus =
  MigrationItemAction | MigrationItemStatus["status"]

const STATUS_BADGE: Record<
  ItemVisualStatus,
  {
    tone: BadgeTone
    labelKey: string
    icon: "import" | "reuse" | "skip" | "done" | "running"
  }
> = {
  import: {
    tone: "info",
    labelKey: "migration.status.willImport",
    icon: "import",
  },
  reuse: {
    tone: "neutral",
    labelKey: "migration.status.willReuse",
    icon: "reuse",
  },
  skip: {
    tone: "warning",
    labelKey: "migration.status.willSkip",
    icon: "skip",
  },
  pending: {
    tone: "neutral",
    labelKey: "migration.status.pending",
    icon: "reuse",
  },
  running: {
    tone: "neutral",
    labelKey: "migration.status.running",
    icon: "running",
  },
  generated: {
    tone: "success",
    labelKey: "migration.status.generated",
    icon: "done",
  },
  reused: {
    tone: "success",
    labelKey: "migration.status.reused",
    icon: "done",
  },
  skipped: {
    tone: "warning",
    labelKey: "migration.status.skipped",
    icon: "skip",
  },
}

const StatusIcon = ({ icon }: { icon: string }) => {
  if (icon === "running") return <Spinner size="xs" className="size-4" />
  if (icon === "done")
    return <CheckCircle aria-hidden="true" className="size-4" />
  if (icon === "skip")
    return <AlertCircle aria-hidden="true" className="size-4" />
  if (icon === "import")
    return <ArrowRight aria-hidden="true" className="size-4" />
  return <MinusCircle aria-hidden="true" className="size-4" />
}

export const MigrationItemCard = ({
  title,
  slug,
  targetName,
  status,
  reason,
  starter,
}: {
  title: string
  slug: string
  targetName: string
  status: ItemVisualStatus
  reason?: MigrationReason
  // Source starter "owner/repo (private|public)" line, shown on the confirm view.
  starter?: string
}) => {
  const { t } = useTranslation()
  const meta = STATUS_BADGE[status]

  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-base-300 bg-base-100 p-4">
      <div className="min-w-0">
        <div className="font-semibold">{title || slug}</div>
        <p className="mt-1 truncate text-sm text-base-content/70">
          {t("migration.item.target", { name: `${targetName}` })}
          {starter ? ` · ${starter}` : ""}
        </p>
        {reason && (
          <p className="mt-1 text-sm text-warning-content/80">
            {t(reason.key, reason.params)}
          </p>
        )}
      </div>
      <Badge tone={meta.tone} size="md" soft={false} className="shrink-0 gap-1">
        <StatusIcon icon={meta.icon} />
        {t(meta.labelKey)}
      </Badge>
    </div>
  )
}

export default MigrationItemCard
