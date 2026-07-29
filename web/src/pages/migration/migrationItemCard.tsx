// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). One assignment row for the confirm
// table and the execute step board: a status badge + target name + reason.
// Mirrors the org-setup InitStep presentation.

import { useTranslation } from "react-i18next"
import { AlertCircle, ArrowRight, CheckCircle, MinusCircle } from "lucide-react"

import { Badge, Spinner, rtlFlip, type BadgeTone } from "@/components/ui"
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
  targetOrg,
  status,
  reason,
  sourceRepo,
  sourcePrivate,
}: {
  title: string
  slug: string
  targetName: string
  // The target org the repo will be created in; when set, the target is shown
  // as `<org>/<name>` so it reads unambiguously against the source.
  targetOrg?: string
  status: ItemVisualStatus
  reason?: MigrationReason
  // Source starter "owner/repo", shown on the confirm view as the FROM side.
  sourceRepo?: string
  sourcePrivate?: boolean
}) => {
  const { t } = useTranslation()
  const meta = STATUS_BADGE[status]
  const targetLabel = targetOrg ? `${targetOrg}/${targetName}` : targetName

  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-base-300 bg-base-100 p-4">
      <div className="min-w-0">
        <div className="font-semibold">{title || slug}</div>

        {/* Explicit source -> target so it's clear what's copied where. */}
        <div className="mt-1.5 flex flex-col gap-1 text-sm sm:flex-row sm:items-center sm:gap-2">
          {sourceRepo && (
            <span className="min-w-0">
              <span className="text-base-content/50">
                {t("migration.item.fromLabel")}{" "}
              </span>
              <span className="font-mono text-base-content/80">
                {sourceRepo}
              </span>
              {sourcePrivate !== undefined && (
                <span className="text-base-content/50">
                  {" "}
                  (
                  {sourcePrivate
                    ? t("migration.item.private")
                    : t("migration.item.public")}
                  )
                </span>
              )}
            </span>
          )}
          {sourceRepo && (
            <ArrowRight
              aria-hidden="true"
              className={`hidden size-3.5 shrink-0 text-base-content/40 sm:inline ${rtlFlip}`}
            />
          )}
          <span className="min-w-0">
            <span className="text-base-content/50">
              {t("migration.item.toLabel")}{" "}
            </span>
            <span className="font-mono text-base-content/80">
              {targetLabel}
            </span>
          </span>
        </div>

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
