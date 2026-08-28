// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). One assignment row for the confirm
// table and the execute step board: a status badge plus a SYMMETRIC two-column
// source (GitHub Classroom) -> target (Classroom 50) metadata table, so a
// teacher can glance across the same rows on both sides.

import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AlertIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  LinkExternalIcon,
  NoEntryIcon,
} from "@/components/ui/icons"

import {
  Badge,
  Collapse,
  Checkbox,
  InlineMessage,
  Input,
  Spinner,
  cx,
  rtlFlip,
  type BadgeTone,
} from "@/components/ui"
import { formatDueDateTime } from "@/util/formatDate"
import { clampMigratedGroupSize } from "@/migration/translate"
import type {
  ClassroomAssignmentDetail,
  MigrationItemAction,
  MigrationItemStatus,
  MigrationReason,
  MigrationRename,
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
    return <CheckCircleIcon aria-hidden="true" className="size-4" />
  if (icon === "skip")
    return <AlertIcon aria-hidden="true" className="size-4" />
  if (icon === "import")
    return <ArrowRightIcon aria-hidden="true" className="size-4" />
  return <NoEntryIcon aria-hidden="true" className="size-4" />
}

// One aligned row in both metadata panels. `value` is already localized text.
type MetaRow = { labelKey: string; source: string; target: string }

// A skip reason the teacher can act on links straight to the fix: flipping the
// template bit lives in the starter repo's settings; a name collision is
// inspected on the existing repo.
function reasonAction(
  reason: MigrationReason,
): { href: string; labelKey: string } | undefined {
  if (
    reason.key === "migration.reason.sourceNotTemplate" &&
    reason.params?.fullName
  ) {
    return {
      href: `https://github.com/${reason.params.fullName}/settings`,
      labelKey: "migration.item.openRepoSettings",
    }
  }
  if (
    reason.key === "migration.reason.targetCollision" &&
    reason.params?.org &&
    reason.params?.name
  ) {
    return {
      href: `https://github.com/${reason.params.org}/${reason.params.name}`,
      labelKey: "migration.item.openCollidingRepo",
    }
  }
  return undefined
}

// A metadata panel: a header (mobile only) + the aligned key/value rows. The
// same MetaRow[] feeds both panels so the source and target line up row-for-row.
// Source and target use distinct accent colors so they're easy to tell apart.
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
  const panelClass =
    side === "source"
      ? "border-info/30 bg-info/5"
      : "border-success/30 bg-success/5"
  const headerClass = side === "source" ? "text-info" : "text-success"
  return (
    <div className={`rounded-field border p-3 ${panelClass}`}>
      <div
        className={`mb-1 text-xs font-medium uppercase tracking-wide ${headerClass}`}
      >
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
  selectable = false,
  selected = false,
  onToggle,
  renamedFrom,
  slugEditValue,
  onSlugEdit,
  slugError,
}: {
  // The full source assignment detail — drives the source column and, since the
  // migration carries these settings across, the target column too. Its `slug`
  // is the IMPORT slug (post-rename); `renamedFrom` carries the source slug.
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
  // When true, the outcome is a checkbox (checked = import, unchecked = skip)
  // instead of a static status badge. Only the confirm screen sets this.
  selectable?: boolean
  selected?: boolean
  onToggle?: () => void
  // Set when the import slug differs from the source slug (auto-trim to the
  // repo-name budget, or the teacher's override).
  renamedFrom?: MigrationRename
  // Editable import slug (confirm screen, pre-run only): the raw field value,
  // the change handler, and the current validation error, all owned by the
  // confirm step so validation matches the preflight it feeds.
  slugEditValue?: string
  onSlugEdit?: (value: string) => void
  slugError?: string
}) => {
  const { t } = useTranslation()
  const meta = STATUS_BADGE[status]
  const action = reason ? reasonAction(reason) : undefined
  // The metadata panels are heavy for long classrooms, so they collapse behind
  // a per-card toggle; the header keeps a one-line repo summary.
  const [detailsOpen, setDetailsOpen] = useState(false)

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

  // Group size the target will use: the same clamp translate applies to the
  // written entry, so the preview never drifts from what migrate writes.
  const targetGroupSize =
    assignment.type === "group"
      ? String(clampMigratedGroupSize(assignment.max_teams))
      : dash
  const sourceGroupSize =
    assignment.type === "group"
      ? assignment.max_teams != null
        ? String(assignment.max_teams)
        : dash
      : dash

  // Feedback PR: migrated assignments start with the Feedback PR OFF (an absent
  // feedback_pr reads as disabled, matching translate + the Go CLI); the teacher
  // re-enables it in the editor afterward. So the target always previews "no".
  const sourceFeedback =
    assignment.feedback_pull_requests_enabled === undefined
      ? dash
      : assignment.feedback_pull_requests_enabled
        ? yes
        : no
  const targetFeedback = no

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
    <div
      className={`rounded-box border border-base-300 bg-base-200 p-4 ${
        selectable && !selected ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone="neutral" size="sm" soft className="shrink-0">
            {t("migration.item.assignmentBadge")}
          </Badge>
          <span className="min-w-0 truncate font-semibold">
            {assignment.title || assignment.slug}
          </span>
        </div>
        {selectable ? (
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              tone="primary"
              checked={selected}
              onChange={() => onToggle?.()}
            />
            <span className={selected ? "font-medium" : "text-base-content/50"}>
              {selected
                ? t("migration.item.willImport")
                : t("migration.item.willSkip")}
            </span>
          </label>
        ) : (
          <Badge
            tone={meta.tone}
            size="md"
            soft={false}
            className="shrink-0 gap-1"
          >
            <StatusIcon icon={meta.icon} />
            {t(meta.labelKey)}
          </Badge>
        )}
      </div>

      <div className="mt-2 flex min-w-0 items-center gap-1.5 text-sm text-base-content/70">
        <span className="truncate">{sourceRepoText}</span>
        <ArrowRightIcon
          aria-hidden="true"
          className={`size-3.5 shrink-0 text-base-content/40 ${rtlFlip}`}
        />
        <span className="truncate">{targetRepoText}</span>
      </div>

      {/* Editable import slug (confirm screen, pre-run, selected items only).
          The confirm step owns validation so the field agrees with the
          preflight it feeds. */}
      {onSlugEdit && selectable && selected && (
        <div className="mt-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="shrink-0 text-base-content/60">
              {t("migration.item.importAsLabel")}
            </span>
            <Input
              inputSize="sm"
              className="max-w-xs font-mono"
              invalid={Boolean(slugError)}
              aria-describedby={
                slugError ? `import-slug-${assignment.slug}-error` : undefined
              }
              value={slugEditValue ?? assignment.slug}
              onChange={(e) => onSlugEdit(e.target.value)}
            />
          </label>
          {slugError && (
            <p
              id={`import-slug-${assignment.slug}-error`}
              className="mt-1 text-sm text-error"
              role="alert"
            >
              {slugError}
            </p>
          )}
        </div>
      )}

      {/* An automatic budget trim is called out; an explicit override is the
          teacher's own edit and needs no note. */}
      {renamedFrom && !renamedFrom.explicit && !slugError && (
        <InlineMessage tone="info" className="mt-2">
          {t("migration.item.autoRenamed", {
            from: renamedFrom.from,
            to: renamedFrom.to,
          })}
        </InlineMessage>
      )}

      {reason && !(selectable && !selected) && (
        <InlineMessage
          tone={
            reason.key === "migration.reason.deselected" ? "neutral" : "warning"
          }
          className="mt-2"
        >
          {t(reason.key, reason.params)}
          {action && (
            <>
              {" "}
              <a
                href={action.href}
                target="_blank"
                rel="noreferrer"
                className="link inline-flex items-center gap-1 align-baseline"
              >
                {t(action.labelKey)}
                <LinkExternalIcon aria-hidden="true" className="size-4" />
              </a>
            </>
          )}
        </InlineMessage>
      )}

      <button
        type="button"
        aria-expanded={detailsOpen}
        onClick={() => setDetailsOpen((o) => !o)}
        className="mt-2 flex cursor-pointer items-center gap-1 text-sm text-base-content/60 hover:text-base-content"
      >
        <ChevronDownIcon
          aria-hidden="true"
          className={cx(
            "size-4 transition-transform",
            detailsOpen && "rotate-180",
          )}
        />
        {t(
          detailsOpen
            ? "migration.item.hideDetails"
            : "migration.item.showDetails",
        )}
      </button>

      <Collapse open={detailsOpen}>
        <div className="grid items-stretch gap-2 pt-3 sm:grid-cols-[1fr_auto_1fr] sm:gap-3">
          <MetaPanel
            headerKey="migration.item.sourcePanel"
            rows={rows}
            side="source"
          />
          <div className="flex items-center justify-center">
            <ArrowRightIcon
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
      </Collapse>
    </div>
  )
}

export default MigrationItemCard
