import { useTranslation } from "react-i18next"
import { Bot, CircleOff, GitCommitHorizontal, Tag } from "lucide-react"

import { Badge, type BadgeSize } from "@/components/ui"
import { LoadingSwap } from "@/lib/LoadingSwap"
import {
  submissionModeBadgeKey,
  submissionModeCountKey,
} from "@/domain/assignments/submissionDetection"
import type { AutogradingState } from "@/domain/assignments/autogradingState"
import { formatSubmissionDateTime } from "@/util/formatDate"
import type { SubmissionMode } from "@/types/classroom"

// The mode's submission icon: a tag for tag mode, a commit for every-push.
// Shared by the count chip and the two mode badges (student page, teacher
// heading) so the mode iconography stays consistent.
export const SubmissionModeIcon = ({
  mode,
  className = "size-3.5",
}: {
  mode: SubmissionMode | undefined
  className?: string
}) =>
  mode === "tag" ? (
    <Tag aria-hidden="true" className={className} />
  ) : (
    <GitCommitHorizontal aria-hidden="true" className={className} />
  )

// The "what counts as a submission" mode badge, shared by the teacher heading
// and the student page so their wording can't drift. Grading is described by
// the separate AutogradingBadge, so this badge never claims a grade.
export const SubmissionModeBadge = ({
  mode,
  size,
}: {
  mode: SubmissionMode | undefined
  size?: BadgeSize
}) => {
  const { t } = useTranslation()
  return (
    <Badge ghost size={size} className="gap-1">
      <SubmissionModeIcon mode={mode} />
      {t(submissionModeBadgeKey(mode))}
    </Badge>
  )
}

// Label + hover detail per autograding tri-state. Built-in autograding needs
// no elaboration; the two no-grading states carry the "what's disabled / what
// still works" detail that used to be a full-width dashboard note.
const autogradingBadgeContent: Record<
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

// The "how is it graded" badge, paired with SubmissionModeBadge on the teacher
// heading and the student page. Keyed off the autograding tri-state so the
// 2-mode x 3-grading combinations stay two independent badges. The detail is
// hover text for sighted users and sr-only text for screen readers.
export const AutogradingBadge = ({
  state,
  size,
}: {
  state: AutogradingState
  size?: BadgeSize
}) => {
  const { t } = useTranslation()
  const { label, title } = autogradingBadgeContent[state]
  const Icon = state === "built-in" ? Bot : CircleOff
  return (
    <Badge
      ghost
      size={size}
      className="gap-1"
      title={title ? t(title) : undefined}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {t(label)}
      {title && <span className="sr-only">{t(title)}</span>}
    </Badge>
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
        <button
          type="button"
          className="badge max-xl:text-xs whitespace-nowrap gap-1 hover:badge-neutral cursor-pointer"
          title={t("submissions.table.viewSubmissionsTitle")}
          onClick={onOpen}
        >
          <SubmissionModeIcon mode={mode} />
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
