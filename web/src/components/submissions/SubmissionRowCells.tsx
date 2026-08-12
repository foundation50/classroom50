import { useTranslation } from "react-i18next"
import { GitCommitHorizontal, Tag } from "lucide-react"

import { Badge, type BadgeSize } from "@/components/ui"
import {
  submissionModeBadgeKey,
  submissionModeCountKey,
} from "@/domain/assignments/submissionDetection"
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
// and the student page so their wording can't drift. `skipsGrading` drops the
// "is graded" claim for assignments that never autograde.
export const SubmissionModeBadge = ({
  mode,
  skipsGrading = false,
  size,
}: {
  mode: SubmissionMode | undefined
  skipsGrading?: boolean
  size?: BadgeSize
}) => {
  const { t } = useTranslation()
  return (
    <Badge ghost size={size} className="gap-1">
      <SubmissionModeIcon mode={mode} />
      {t(submissionModeBadgeKey(mode, skipsGrading))}
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
}: {
  mode: SubmissionMode | undefined
  count: number
  onOpen: () => void
  // Teacher-only: the collected count lags live/detected data; show the "New"
  // hint alongside the chip. Omitted on the student view.
  staleCount?: boolean
}) => {
  const { t } = useTranslation()
  return (
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
  )
}

// The "last submitted" cell: the latest submission time plus optional teacher-
// only sub-lines (late badge, graded-at, live-latest). The student view passes
// only `datetime`, so the sub-lines collapse away.
//
// A detection-only / not-yet-collected teacher row carries no graded submission
// time (empty `datetime`), so the primary line shows a neutral "not yet
// collected" placeholder instead of a formatted "Invalid Date". A real latest-
// push time, when known, still surfaces on the `liveLatestAt` sub-line.
export const LastSubmittedCell = ({
  datetime,
  late = false,
  gradedAt,
  liveLatestAt,
}: {
  datetime: string
  late?: boolean
  gradedAt?: string
  liveLatestAt?: string
}) => {
  const { t } = useTranslation()
  const hasDatetime = !Number.isNaN(new Date(datetime).getTime())
  return (
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
  )
}
