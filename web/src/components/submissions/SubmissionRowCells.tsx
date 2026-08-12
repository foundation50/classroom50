import { useTranslation } from "react-i18next"
import { GitCommitHorizontal, Tag } from "lucide-react"

import { Badge } from "@/components/ui"
import { submissionModeCountKey } from "@/domain/assignments/submissionDetection"
import type { SubmissionMode } from "@/types/classroom"

const formatDateTime = (datetime: string) =>
  new Date(datetime).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })

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
        {mode === "tag" ? (
          <Tag aria-hidden="true" className="size-3.5" />
        ) : (
          <GitCommitHorizontal aria-hidden="true" className="size-3.5" />
        )}
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
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <span className="whitespace-nowrap">{formatDateTime(datetime)}</span>
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
          {t("submissions.table.gradedAt", { date: formatDateTime(gradedAt) })}
        </span>
      ) : null}
      {liveLatestAt ? (
        <span
          className="whitespace-nowrap text-xs text-info"
          title={t("submissions.table.liveLatestTitle")}
        >
          {t("submissions.table.liveLatest", {
            date: formatDateTime(liveLatestAt),
          })}
        </span>
      ) : null}
    </div>
  )
}
