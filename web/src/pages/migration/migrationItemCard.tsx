// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). One assignment row for the confirm
// table and the execute step board: a status badge plus a SYMMETRIC two-column
// source (GitHub Classroom) -> target (Classroom 50) metadata table, so a
// teacher can glance across the same rows on both sides.

import { useTranslation } from "react-i18next"
import { AlertCircle, ArrowRight, CheckCircle, MinusCircle } from "lucide-react"

import { Badge, Spinner, rtlFlip, type BadgeTone } from "@/components/ui"
import { formatDueDateTime } from "@/util/formatDate"
import type {
  ClassroomAssignmentDetail,
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

// One aligned row in both metadata panels. `value` is already localized text.
type MetaRow = { labelKey: string; source: string; target: string }

// A metadata panel: a header (mobile only) + the aligned key/value rows. The
// same MetaRow[] feeds both panels so the source and target line up row-for-row.
const MetaPanel = ({
  headerKey,
  rows,
  side,
}: {
  headerKey: string
  rows: MetaRow[]
  side: "source" | "target"
}) => {
  const { t } = useTranslation()
  return (
    <div className="rounded-lg border border-base-200 bg-base-200/40 p-3">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-base-content/50 sm:hidden">
        {t(headerKey)}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-sm">
        {rows.map((r) => (
          <div key={r.labelKey} className="contents">
            <dt className="text-base-content/50">{t(r.labelKey)}</dt>
            <dd className="truncate text-base-content/80">
              {side === "source" ? r.source : r.target}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export const MigrationItemCard = ({
  assignment,
  status,
  reason,
  targetName,
  targetOrg,
  targetBranch,
  templateLess,
}: {
  // The full source assignment detail — drives the source column and, since the
  // migration carries these settings across, the target column too.
  assignment: ClassroomAssignmentDetail
  status: ItemVisualStatus
  reason?: MigrationReason
  targetName: string
  // The target org; the target repo reads as `<org>/<name>`.
  targetOrg?: string
  // Target repo default branch, when known (reuse of an existing template).
  targetBranch?: string
  // No starter repo: imported as a template-less (empty) assignment.
  templateLess?: boolean
}) => {
  const { t } = useTranslation()
  const meta = STATUS_BADGE[status]

  const starter = assignment.starter_code_repository
  const targetRepoLabel = targetOrg ? `${targetOrg}/${targetName}` : targetName

  const yes = t("migration.item.yes")
  const no = t("migration.item.no")
  const dash = "—"

  const typeText =
    assignment.type === "group"
      ? t("migration.item.typeGroup")
      : assignment.type === "individual"
        ? t("migration.item.typeIndividual")
        : assignment.type

  // Group size the target will use (source max_teams, clamped later by translate).
  const targetGroupSize =
    assignment.type === "group"
      ? String(
          assignment.max_teams && assignment.max_teams >= 2
            ? assignment.max_teams
            : 100,
        )
      : dash
  const sourceGroupSize =
    assignment.type === "group"
      ? assignment.max_teams != null
        ? String(assignment.max_teams)
        : dash
      : dash

  // Feedback PR: template-less assignments can't have one on the target.
  const sourceFeedback =
    assignment.feedback_pull_requests_enabled === undefined
      ? dash
      : assignment.feedback_pull_requests_enabled
        ? yes
        : no
  const targetFeedback = templateLess
    ? no
    : assignment.feedback_pull_requests_enabled === false
      ? no
      : yes

  const deadlineText = assignment.deadline
    ? formatDueDateTime(assignment.deadline)
    : t("migration.item.none")

  const sourceRepoText = templateLess
    ? t("migration.item.noSource")
    : (starter?.full_name ?? dash)
  const targetRepoText = templateLess
    ? t("migration.item.emptyRepo")
    : targetRepoLabel

  const sourceVisibility =
    starter?.private === undefined
      ? dash
      : starter.private
        ? t("migration.item.private")
        : t("migration.item.public")
  // The target template inherits the source's visibility on generate.
  const targetVisibility = templateLess ? dash : sourceVisibility

  const rows: MetaRow[] = [
    {
      labelKey: "migration.item.repoLabel",
      source: sourceRepoText,
      target: targetRepoText,
    },
    {
      labelKey: "migration.item.typeLabel",
      source: typeText,
      target: typeText,
    },
    ...(assignment.type === "group"
      ? [
          {
            labelKey: "migration.item.groupSizeLabel",
            source: sourceGroupSize,
            target: targetGroupSize,
          },
        ]
      : []),
    {
      labelKey: "migration.item.feedbackLabel",
      source: sourceFeedback,
      target: targetFeedback,
    },
    {
      labelKey: "migration.item.deadlineLabel",
      source: deadlineText,
      target: deadlineText,
    },
    {
      labelKey: "migration.item.branchLabel",
      source: starter?.default_branch ?? dash,
      target: templateLess
        ? dash
        : (targetBranch ?? starter?.default_branch ?? dash),
    },
    {
      labelKey: "migration.item.visibilityLabel",
      source: sourceVisibility,
      target: targetVisibility,
    },
  ]

  return (
    <div className="rounded-xl border border-base-300 bg-base-100 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 font-semibold">
          {assignment.title || assignment.slug}
        </div>
        <Badge
          tone={meta.tone}
          size="md"
          soft={false}
          className="shrink-0 gap-1"
        >
          <StatusIcon icon={meta.icon} />
          {t(meta.labelKey)}
        </Badge>
      </div>

      <div className="mt-3 grid items-stretch gap-2 sm:grid-cols-[1fr_auto_1fr] sm:gap-3">
        <MetaPanel
          headerKey="migration.item.sourcePanel"
          rows={rows}
          side="source"
        />
        <div className="flex items-center justify-center">
          <ArrowRight
            aria-hidden="true"
            className={`hidden size-4 text-base-content/40 sm:block ${rtlFlip}`}
          />
        </div>
        <MetaPanel
          headerKey="migration.item.targetPanel"
          rows={rows}
          side="target"
        />
      </div>

      {reason && (
        <p className="mt-2 text-sm text-warning-content/80">
          {t(reason.key, reason.params)}
        </p>
      )}
    </div>
  )
}

export default MigrationItemCard
