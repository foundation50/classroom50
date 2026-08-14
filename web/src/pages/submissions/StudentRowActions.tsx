import { useTranslation } from "react-i18next"
import { History, ScrollText } from "lucide-react"

import { Button } from "@/components/ui"
import { ActionIconLink } from "@/pages/submissions/SubmissionsRows"
import { IndividualRowHeader } from "@/pages/submissions/SubmissionsRowActions"

// The student Actions cell: an Open-repository shortcut (reusing the teacher
// row's IndividualRowHeader so the affordance matches), an optional direct
// "View autograder details" link to the latest graded release, and a "View
// submissions" trigger that opens the shared details modal. Deliberately omits
// every teacher-only action (Manage/Regrade/Download/Access) — a student can
// only read their own repo and inspect their submissions.
export const StudentRowActions = ({
  repo,
  repoHref,
  hasRepo,
  latestReleaseHref,
  onViewSubmissions,
}: {
  repo: string
  repoHref: string
  hasRepo: boolean
  latestReleaseHref?: string
  onViewSubmissions: () => void
}) => {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-1">
      <IndividualRowHeader repo={repo} repoHref={repoHref} hasRepo={hasRepo} />
      {latestReleaseHref ? (
        <ActionIconLink
          href={latestReleaseHref}
          icon={ScrollText}
          label={t("submissions.table.viewDetails")}
          title={t("submissions.table.viewDetails")}
          emptyLabel={t("submissions.table.viewDetails")}
          emptyTitle={t("submissions.table.viewDetails")}
        />
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        shape="square"
        className="text-base-content/70"
        onClick={onViewSubmissions}
        aria-label={t("submissions.details.viewSubmissions")}
        title={t("submissions.details.viewSubmissions")}
      >
        <History aria-hidden="true" className="size-4" />
      </Button>
    </div>
  )
}
