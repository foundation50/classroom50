import { Fragment, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
  CircleSlashIcon,
  GitCommitIcon,
  HubotIcon,
  TagIcon,
} from "@/components/ui/icons"

import { Badge } from "@/components/ui"
import { LoadingSwap } from "@/lib/LoadingSwap"
import {
  submissionModeBadgeKey,
  submissionModeCountKey,
} from "@/domain/assignments/submissionDetection"
import type { AutogradingState } from "@/domain/assignments/autogradingState"
import { formatSubmissionDateTime } from "@/util/formatDate"
import type { SubmissionMode } from "@/types/classroom"

// The mode's submission icon: a tag for tag mode, a commit for every-push.
// Used by the teacher heading's mode meta item.
const SubmissionModeIcon = ({
  mode,
  className = "size-3.5",
}: {
  mode: SubmissionMode | undefined
  className?: string
}) =>
  mode === "tag" ? (
    <TagIcon aria-hidden="true" className={className} />
  ) : (
    <GitCommitIcon aria-hidden="true" className={className} />
  )

// ── Assignment-property meta strip ──────────────────────────────────────────
// The teacher heading and student page describe assignment properties (mode,
// grading, due date, template) as one quiet GitHub-style meta line: icon +
// muted text per item, thin dividers between items. Properties are text;
// only genuine states (overdue, late, closed) keep toned badges.

/** One quiet property item: icon + muted text (+ optional hover detail). */
export const MetaItem = ({
  title,
  children,
}: {
  title?: string
  children: ReactNode
}) => (
  <span
    className="inline-flex items-center gap-1.5 whitespace-nowrap text-base-content/70"
    title={title}
  >
    {children}
  </span>
)

/** Thin vertical rule between meta items. */
export const MetaDivider = () => (
  <span aria-hidden="true" className="h-4 w-px shrink-0 bg-base-content/20" />
)

/** The strip itself: filters out absent items and interleaves dividers, so
 *  callers list items declaratively without divider bookkeeping. */
export const MetaStrip = ({ items }: { items: ReactNode[] }) => {
  const present = items.filter(
    (item) => item !== null && item !== undefined && item !== false,
  )
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {present.map((item, i) => (
        <Fragment key={i}>
          {i > 0 && <MetaDivider />}
          {item}
        </Fragment>
      ))}
    </div>
  )
}

// The "what counts as a submission" property on the teacher heading (the
// student page deliberately omits it — how to submit is the guidance box's
// job there). Grading is described by the separate AutogradingMeta, so this
// item never claims a grade.
export const SubmissionModeMeta = ({
  mode,
}: {
  mode: SubmissionMode | undefined
}) => {
  const { t } = useTranslation()
  return (
    <MetaItem>
      <SubmissionModeIcon mode={mode} />
      {t(submissionModeBadgeKey(mode))}
    </MetaItem>
  )
}

// Label + hover detail per autograding tri-state. Built-in autograding needs
// no elaboration; the two no-grading states carry the "what's disabled / what
// still works" detail that used to be a full-width dashboard note.
const autogradingMetaContent: Record<
  AutogradingState,
  { label: string; title?: string }
> = {
  "built-in": { label: "submissions.grading.badgeBuiltIn" },
  none: {
    label: "submissions.grading.badgeNoAutograder",
    title: "submissions.grading.titleNoAutograder",
  },
  empty: {
    label: "submissions.grading.badgeEmptyRepo",
    title: "submissions.grading.titleEmptyRepo",
  },
}

// The "how is it graded" property, paired with SubmissionModeMeta on the
// teacher heading (omitted from the student page — grading internals aren't
// actionable there). Keyed off the autograding tri-state so the 2-mode x
// 3-grading combinations stay two independent items. The detail is hover text
// for sighted users and sr-only text for screen readers.
export const AutogradingMeta = ({ state }: { state: AutogradingState }) => {
  const { t } = useTranslation()
  const { label, title } = autogradingMetaContent[state]
  const Icon = state === "built-in" ? HubotIcon : CircleSlashIcon
  return (
    <MetaItem title={title ? t(title) : undefined}>
      <Icon aria-hidden="true" className="size-3.5" />
      {t(label)}
      {title && <span className="sr-only">{t(title)}</span>}
    </MetaItem>
  )
}

// The type-aware submission-count chip, shared by the teacher table and the
// student page. Always a button so it consistently opens the details modal —
// even for 0/1 submissions, where the modal owns the empty state. `count` is
// the number of listed submissions for the chosen mode.
export const SubmissionCountCell = ({
  mode,
  count,
  onOpen,
  staleCount = false,
  settling = false,
}: {
  mode: SubmissionMode | undefined
  count: number
  onOpen: () => void
  // Teacher-only: the collected count lags live/detected data; show the "New"
  // hint alongside the chip. Omitted on the student view.
  staleCount?: boolean
  // Teacher-only: the current page's live/detected data is still resolving, so
  // shimmer the chip until the count settles rather than popping a stale value.
  settling?: boolean
}) => {
  const { t } = useTranslation()
  return (
    <LoadingSwap
      loading={settling}
      deferUntilLoaded
      fallback={<div className="skeleton skeleton-shimmer h-5 w-16" />}
    >
      <div className="flex items-center gap-1.5">
        {/* Success-toned like the Submitted progress bars: a green chip = a
            submission exists. Hover deepens the fill as the click affordance.
            A real <button> wearing the badge recipe — Badge renders a span,
            and this chip is interactive, so it stays inline. */}
        <button
          type="button"
          className="badge badge-sm badge-success badge-soft whitespace-nowrap gap-1 hover:bg-success/20 cursor-pointer"
          title={t(
            mode === "tag"
              ? "submissions.table.viewSubmissionsTitleTag"
              : "submissions.table.viewSubmissionsTitleEveryPush",
          )}
          onClick={onOpen}
        >
          {t(submissionModeCountKey(mode), { count })}
        </button>
        {staleCount ? (
          <Badge
            tone="info"
            size="sm"
            title={t("submissions.table.staleCountTitle")}
          >
            {t("submissions.table.staleCount")}
          </Badge>
        ) : null}
      </div>
    </LoadingSwap>
  )
}

// The "last submitted" cell: the latest submission time plus optional teacher-
// only sub-lines (late badge, graded-at, live-latest). The student view passes
// only `datetime`, so the sub-lines collapse away.
//
// A not-yet-collected teacher row without any detectable time (e.g. a
// milestone tag whose commit lookup failed) carries an empty `datetime`, so
// the primary line shows a neutral "not yet collected" placeholder instead of
// a formatted "Invalid Date". Branch-mode commits, canonical submit/* tags,
// and dated milestone tags all render a real timestamp.
export const LastSubmittedCell = ({
  datetime,
  late = false,
  gradedAt,
  liveLatestAt,
  settling = false,
}: {
  datetime: string
  late?: boolean
  gradedAt?: string
  liveLatestAt?: string
  // Teacher-only: the current page's live/detected data is still resolving, so
  // shimmer the time until it settles rather than popping a stale/placeholder.
  settling?: boolean
}) => {
  const { t } = useTranslation()
  const hasDatetime = !Number.isNaN(new Date(datetime).getTime())
  return (
    <LoadingSwap
      loading={settling}
      deferUntilLoaded
      fallback={<div className="skeleton skeleton-shimmer h-4 w-28" />}
    >
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          {hasDatetime ? (
            <span className="whitespace-nowrap">
              {formatSubmissionDateTime(datetime)}
            </span>
          ) : (
            <span
              className="whitespace-nowrap text-base-content/50"
              title={t("submissions.table.notCollectedYetTitle")}
            >
              {t("submissions.table.notCollectedYet")}
            </span>
          )}
          {late ? (
            <Badge tone="error" title={t("submissions.table.lateRowTitle")}>
              {t("submissions.table.late")}
            </Badge>
          ) : null}
        </div>
        {gradedAt && gradedAt !== datetime ? (
          <span
            className="whitespace-nowrap text-xs text-base-content/70"
            title={t("submissions.table.gradedAtTitle")}
          >
            {t("submissions.table.gradedAt", {
              date: formatSubmissionDateTime(gradedAt),
            })}
          </span>
        ) : null}
        {liveLatestAt ? (
          <span
            className="whitespace-nowrap text-xs text-info"
            title={t("submissions.table.liveLatestTitle")}
          >
            {t("submissions.table.liveLatest", {
              date: formatSubmissionDateTime(liveLatestAt),
            })}
          </span>
        ) : null}
      </div>
    </LoadingSwap>
  )
}
