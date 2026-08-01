import {
  Download,
  GitCommitHorizontal,
  RefreshCw,
  ScrollText,
  ShieldCheck,
} from "lucide-react"
import { useState } from "react"
import { Trans, useTranslation } from "react-i18next"

import GitHub from "@/assets/github.svg?react"
import { safeHttpUrl } from "@/util/url"
import { Button, EmphasisLtr } from "@/components/ui"
import { ConfirmModal } from "@/components/modals"
import { ActionIconLink } from "@/pages/submissions/SubmissionsRows"
import { ReviewButton } from "@/pages/submissions/ReviewButton"
import useTriggerRegrade from "@/hooks/useTriggerRegrade"
import useDownloadSubmission from "@/hooks/mutations/useDownloadSubmission"
import { useToast } from "@/context/notifications/NotificationProvider"
import type { AssignmentMode } from "@/types/classroom"

// Per-row regrade: dispatches regrade.yaml scoped to one owner, tracked via
// useTriggerRegrade (icon shows progress; disabled while any regrade is in
// flight). Only kicks off grading — the gradebook refreshes on the next collect.
//
// A never-accepted non-submitter (`noRepo`) renders a static disabled button and
// deliberately does NOT mount the tracking hook or confirm modal: with no repo
// there's nothing to regrade, and skipping the machinery avoids a per-row
// sessionStorage read and a hidden confirm dialog on rosters full of
// never-accepted students.
export const RegradeButton = ({
  noRepo = false,
  ...props
}: {
  org: string
  classroom: string
  assignment: string
  owner: string
  // The student's display name (individual assignments) when known; falls back
  // to `owner`. Omitted for group repos (owner is the founder/group).
  displayName?: string
  noRepo?: boolean
}) => {
  const { t } = useTranslation()
  if (noRepo) {
    return (
      <Button
        variant="ghost"
        size="sm"
        shape="square"
        className="text-base-content/70 disabled:opacity-60"
        disabled
        aria-label={t("submissions.rowRegrade.aria", { owner: props.owner })}
        title={t("submissions.rowRegrade.titleNoRepo")}
      >
        <RefreshCw aria-hidden="true" className="size-4" />
      </Button>
    )
  }
  return <ActiveRegradeButton {...props} />
}

const ActiveRegradeButton = ({
  org,
  classroom,
  assignment,
  owner,
  displayName,
}: {
  org: string
  classroom: string
  assignment: string
  owner: string
  displayName?: string
}) => {
  const { t } = useTranslation()
  const { regrade, phase, anyRegrading } = useTriggerRegrade({
    org,
    classroom,
    assignment,
    owner,
  })
  const inFlight = phase === "dispatching" || phase === "running"
  // Disable while ANY regrade (this row, another, or "Regrade all") is in flight:
  // trackers share one regrade.yaml run list and bind by monotonic id, so a
  // single outstanding dispatch keeps the binding unambiguous.
  const blocked = anyRegrading && !inFlight
  const [confirmOpen, setConfirmOpen] = useState(false)

  const title = inFlight
    ? t("submissions.rowRegrade.titleInFlight")
    : blocked
      ? t("submissions.rowRegrade.titleBlocked")
      : phase === "completed"
        ? t("submissions.rowRegrade.titleCompleted")
        : phase === "failed"
          ? t("submissions.rowRegrade.titleFailed")
          : t("submissions.rowRegrade.title")

  const handleClick = () => {
    if (inFlight || blocked) return
    setConfirmOpen(true)
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        shape="square"
        className="text-base-content/70 disabled:opacity-60"
        disabled={inFlight || blocked}
        loading={inFlight}
        loadingLabel={t("submissions.rowRegrade.title")}
        onClick={handleClick}
        aria-label={t("submissions.rowRegrade.aria", { owner })}
        title={title}
      >
        {!inFlight && (
          <RefreshCw
            aria-hidden="true"
            className={`size-4 ${phase === "completed" ? "text-success" : phase === "failed" ? "text-error" : ""}`}
          />
        )}
      </Button>
      <ConfirmModal
        open={confirmOpen}
        title={t("submissions.rowRegrade.confirmTitle", {
          name: displayName || owner,
        })}
        description={
          <>
            <Trans
              i18nKey={
                displayName
                  ? "submissions.rowRegrade.confirmBody1WithLogin"
                  : "submissions.rowRegrade.confirmBody1"
              }
              values={{ name: displayName || owner, owner }}
              components={{
                name: <span className="font-semibold text-base-content" />,
                owner: <EmphasisLtr className="font-normal" />,
              }}
            />
            <br />
            <br />
            <Trans
              i18nKey="submissions.rowRegrade.confirmBody2"
              values={{ collectLabel: t("submissions.collect.label") }}
              components={{
                collectLabel: <span className="font-semibold" />,
              }}
            />
          </>
        }
        confirmText="regrade"
        confirmLabel={t("submissions.rowRegrade.confirmLabel")}
        cancelLabel={t("common.cancel")}
        dangerous={false}
        needsConfirm={false}
        onConfirm={async () => {
          regrade()
        }}
        onClose={() => setConfirmOpen(false)}
      />
    </>
  )
}

// Per-row submission download. A button, not a link, because it triggers an
// authenticated fetch, not a navigation.
export const DownloadButton = ({
  org,
  classroom,
  assignment,
  owner,
  noRepo = false,
}: {
  org: string
  classroom: string
  assignment: string
  owner: string
  noRepo?: boolean
}) => {
  const { t } = useTranslation()
  const { notify } = useToast()
  const download = useDownloadSubmission()

  return (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      className="text-base-content/70 disabled:opacity-60"
      disabled={noRepo || download.isPending}
      loading={download.isPending}
      loadingLabel={t("submissions.rowDownload.title")}
      onClick={() => {
        if (noRepo || download.isPending) return
        download.mutate(
          { org, classroom, assignment, owner },
          {
            onError: (err) => {
              // "no-submission" (missing/never-pushed repo) is benign info,
              // not an error.
              const nothing =
                err instanceof Error && err.message === "no-submission"
              notify({
                tone: nothing ? "info" : "error",
                message: nothing
                  ? t("submissions.rowDownload.nothingToDownload", { owner })
                  : t("submissions.rowDownload.error", { owner }),
              })
            },
          },
        )
      }}
      aria-label={t("submissions.rowDownload.aria", { owner })}
      title={
        noRepo
          ? t("submissions.rowDownload.titleNoRepo")
          : t("submissions.rowDownload.title")
      }
    >
      {!download.isPending && (
        <Download aria-hidden="true" className="size-4" />
      )}
    </Button>
  )
}

// The per-repo action cluster shared by every row family — submitted,
// non-submitter, and group. Group and individual rows differ only in the
// leading `header` (Open-repo link vs. Members + repo link), the `mode` passed
// to Review, and whether the per-student Manage-access button applies; the tail
// (commit -> Review -> [access] -> details -> Regrade -> Download) is identical,
// so it lives here once rather than being hand-copied per branch.
//
// Actions split by what they actually need:
//   - repo-only (Open repo, Review PR, Manage access, Regrade, Download): a repo
//     exists the moment a student accepts, so these stay live for an
//     accepted-not-submitted student and only disable when no repo exists at all.
//   - submission-only (View commit, View details): tied to a specific attempt,
//     so they render dimmed (via ActionIconLink's empty branch) until one lands.
// `emptyRepo` assignments never autograde, so their PR/regrade/details actions
// disable regardless (kept visible, greyed, so the row layout doesn't jump).
export const RepoRowActions = ({
  mode,
  org,
  classroom,
  assignment,
  owner,
  repo,
  hasRepo,
  commit,
  release,
  emptyRepo,
  displayName,
  header,
  onManageAccess,
}: {
  mode: AssignmentMode
  org: string
  classroom: string
  assignment: string
  owner: string
  repo: string
  // Whether an assignment repo exists (submitted, or accepted-not-submitted). A
  // never-accepted individual non-submitter has none, so the repo-scoped actions
  // disable. Group rows always have a repo.
  hasRepo: boolean
  // Latest attempt's commit/release URLs, when a submission exists.
  commit?: string | null
  release?: string | null
  emptyRepo: boolean
  displayName?: string
  // The leading affordance for this row family (Open-repo link for individuals,
  // Members + repo link for groups).
  header: React.ReactNode
  // Individual per-student Manage-access action; omitted for group rows (access
  // is managed through the group Members modal instead).
  onManageAccess?: () => void
}) => {
  const { t } = useTranslation()
  return (
    <>
      {header}
      <ActionIconLink
        href={safeHttpUrl(commit)}
        icon={GitCommitHorizontal}
        label={t("submissions.table.viewCommit")}
        title={t("submissions.table.commit")}
        emptyLabel={t("submissions.table.noCommit")}
        emptyTitle={t("submissions.table.noCommit")}
      />
      {!emptyRepo && (
        <>
          <ReviewButton org={org} repo={repo} mode={mode} noRepo={!hasRepo} />
          {onManageAccess && (
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              className="text-base-content/70 disabled:opacity-60"
              disabled={!hasRepo}
              aria-label={t("submissions.table.manageAccessAria", { owner })}
              title={
                hasRepo
                  ? t("submissions.table.manageAccess")
                  : t("submissions.table.manageAccessNoRepo")
              }
              onClick={() => {
                if (!hasRepo) return
                onManageAccess()
              }}
            >
              <ShieldCheck aria-hidden="true" className="size-4" />
            </Button>
          )}
          <ActionIconLink
            href={safeHttpUrl(release)}
            icon={ScrollText}
            label={t("submissions.table.viewDetails")}
            title={t("submissions.table.details")}
            emptyLabel={t("submissions.table.noDetailsLabel")}
            emptyTitle={t("submissions.table.noDetails")}
          />
          <RegradeButton
            org={org}
            classroom={classroom}
            assignment={assignment}
            owner={owner}
            displayName={displayName}
            noRepo={!hasRepo}
          />
        </>
      )}
      <DownloadButton
        org={org}
        classroom={classroom}
        assignment={assignment}
        owner={owner}
        noRepo={!hasRepo}
      />
    </>
  )
}

// Convenience header for an individual row: a single Open-repo link, dimmed to a
// disabled icon when no repo exists yet.
export const IndividualRowHeader = ({
  repo,
  repoHref,
  hasRepo,
}: {
  repo: string
  repoHref: string
  hasRepo: boolean
}) => {
  const { t } = useTranslation()
  return (
    <ActionIconLink
      href={hasRepo ? repoHref : null}
      icon={GitHub}
      label={t("submissions.table.openRepoLabel", { repo })}
      title={t("submissions.table.viewRepo")}
      emptyLabel={t("submissions.table.openRepoLabel", { repo })}
      emptyTitle={t("submissions.table.viewRepo")}
    />
  )
}
