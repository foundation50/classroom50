import {
  Download,
  GitBranch,
  GitCommitHorizontal,
  RefreshCw,
  ScrollText,
  Settings2,
  ShieldCheck,
} from "lucide-react"
import { useState } from "react"
import { Trans, useTranslation } from "react-i18next"

import GitHub from "@/assets/github.svg?react"
import { safeHttpUrl } from "@/util/url"
import { Button, EmphasisLtr } from "@/components/ui"
import { ConfirmModal } from "@/components/modals"
import { ActionIconLink } from "@/pages/submissions/SubmissionsRows"
import { ActionListRow } from "@/pages/submissions/actionLayout"
import { ReviewButton } from "@/pages/submissions/ReviewButton"
import useTriggerRegrade from "@/hooks/useTriggerRegrade"
import useDownloadSubmission from "@/hooks/mutations/useDownloadSubmission"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import { updateShimSubmissionMode } from "@/domain/assignments/submissionTrigger"
import type { AssignmentMode, SubmissionMode } from "@/types/classroom"

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
      <ActionListRow
        icon={RefreshCw}
        title={t("submissions.rowRegrade.title")}
        description={t("submissions.manageModal.regradeDescription")}
        onClick={() => {}}
        disabled
        ariaLabel={t("submissions.rowRegrade.aria", { owner: props.owner })}
      />
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
      <ActionListRow
        icon={RefreshCw}
        title={t("submissions.rowRegrade.title")}
        description={
          // Surface live phase (in progress / blocked / completed / failed) so
          // the hub reflects the same state the icon button used to show in its
          // tooltip; falls back to the static description at rest.
          inFlight || blocked || phase === "completed" || phase === "failed"
            ? title
            : t("submissions.manageModal.regradeDescription")
        }
        onClick={handleClick}
        disabled={inFlight || blocked}
        loading={inFlight}
        loadingLabel={t("submissions.rowRegrade.title")}
        ariaLabel={t("submissions.rowRegrade.aria", { owner })}
      />
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

  const start = () => {
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
  }

  return (
    <ActionListRow
      icon={Download}
      title={t("submissions.rowDownload.title")}
      description={t("submissions.manageModal.downloadDescription")}
      onClick={start}
      disabled={noRepo}
      loading={download.isPending}
      loadingLabel={t("submissions.rowDownload.title")}
      ariaLabel={t("submissions.rowDownload.aria", { owner })}
    />
  )
}

// The per-repo Actions cell, shared by every row family (submitted,
// non-submitter, group). It now holds just two affordances: the leading
// Open-repo shortcut (`header`) and a single Manage trigger that opens the
// submission hub (ManageSubmissionModal), where every other action —
// commit, Review, access, details, regrade, download — lives as a labeled row.
// Consolidating keeps the dense table to one GitHub-repo shortcut plus one
// entry point that scales as we add actions, instead of a growing icon cluster.
export const RepoRowActions = ({
  owner,
  header,
  onManage,
}: {
  owner: string
  // The leading affordance for this row family (Open-repo link for individuals,
  // repo link for groups).
  header: React.ReactNode
  // Opens the submission hub for this row.
  onManage: () => void
}) => {
  const { t } = useTranslation()
  return (
    <>
      {header}
      <Button
        variant="ghost"
        size="sm"
        shape="square"
        className="text-base-content/70"
        onClick={onManage}
        aria-label={t("submissions.manageModal.openAria", { owner })}
        title={t("submissions.manageModal.open")}
      >
        <Settings2 aria-hidden="true" className="size-4" />
      </Button>
    </>
  )
}

// The submission hub's body: every consolidated action as a labeled list row.
// Simple actions (commit/details links, Review, Regrade, Download) run in place;
// the rich access/members editors open stacked on top of the hub (native
// <dialog> nesting) via `onManageAccess`/`onManageMembers`, with the hub left
// open underneath — see ManageSubmissionModal for the stacking rationale.
//
// Gating mirrors the old cluster: repo-only actions (Review, access, regrade,
// download) disable only when no repo exists; submission-only links
// (commit, details) dim until an attempt lands; `emptyRepo` assignments omit
// the PR/access/details/regrade actions entirely.
export type SubmissionActionListProps = {
  mode: AssignmentMode
  org: string
  classroom: string
  assignment: string
  owner: string
  repo: string
  hasRepo: boolean
  commit?: string | null
  // The repo's true latest commit (default-branch tip). When present it links
  // the "View latest commit" action, since `commit` is only the latest *graded*
  // snapshot from scores.json and can lag a fresh push. Falls back to `commit`.
  latestCommitHref?: string | null
  release?: string | null
  emptyRepo: boolean
  displayName?: string
  // Opens the individual per-student access editor (stacked on the hub);
  // omitted for group rows (access is managed through the group Members editor).
  onManageAccess?: () => void
  // The assignment's submission_mode, enabling the per-repo "Update
  // autograding trigger" action (the single-repo twin of the bulk retrofit).
  // Omitted (action hidden) for custom-autograder assignments — teacher-
  // authored shims are never rewritten — and for non-owners.
  submissionMode?: SubmissionMode
  // The assignment's milestone submission_tags (if any) for the same action.
  submissionTags?: string[]
}

export const SubmissionActionList = ({
  mode,
  org,
  classroom,
  assignment,
  owner,
  repo,
  hasRepo,
  commit,
  latestCommitHref,
  release,
  emptyRepo,
  displayName,
  onManageAccess,
  submissionMode,
  submissionTags,
}: SubmissionActionListProps) => {
  const { t } = useTranslation()
  const commitHref = latestCommitHref ?? safeHttpUrl(commit)
  const releaseHref = safeHttpUrl(release)
  return (
    <div className="flex flex-col">
      <ActionListRow
        icon={GitCommitHorizontal}
        title={t("submissions.table.viewCommit")}
        description={
          commitHref
            ? t("submissions.manageModal.commitDescription")
            : t("submissions.table.noCommit")
        }
        href={commitHref ?? undefined}
        onClick={commitHref ? undefined : () => {}}
        disabled={!commitHref}
        external
      />
      {!emptyRepo && (
        <>
          <ReviewButton org={org} repo={repo} mode={mode} noRepo={!hasRepo} />
          {onManageAccess && (
            <ActionListRow
              icon={ShieldCheck}
              title={t("submissions.table.manageAccess")}
              description={t("submissions.manageModal.accessDescription")}
              onClick={onManageAccess}
              disabled={!hasRepo}
              ariaLabel={t("submissions.table.manageAccessAria", { owner })}
            />
          )}
          <ActionListRow
            icon={ScrollText}
            title={t("submissions.table.viewDetails")}
            description={
              releaseHref
                ? t("submissions.manageModal.detailsDescription")
                : t("submissions.table.noDetails")
            }
            href={releaseHref ?? undefined}
            onClick={releaseHref ? undefined : () => {}}
            disabled={!releaseHref}
            external
          />
          <RegradeButton
            org={org}
            classroom={classroom}
            assignment={assignment}
            owner={owner}
            displayName={displayName}
            noRepo={!hasRepo}
          />
          {submissionMode && (
            <UpdateTriggerButton
              org={org}
              repo={repo}
              submissionMode={submissionMode}
              submissionTags={submissionTags}
              noRepo={!hasRepo}
            />
          )}
        </>
      )}
      <DownloadButton
        org={org}
        classroom={classroom}
        assignment={assignment}
        owner={owner}
        noRepo={!hasRepo}
      />
    </div>
  )
}

// Per-row autograding-trigger retrofit: rewrite this one repo's shim to the
// assignment's submission_mode — the single-repo twin of the bulk modal (for
// a repo that was skipped/failed there, or a single late accepter). The
// domain call is idempotent; the toast reports which outcome happened.
const UpdateTriggerButton = ({
  org,
  repo,
  submissionMode,
  submissionTags,
  noRepo,
}: {
  org: string
  repo: string
  submissionMode: SubmissionMode
  submissionTags?: string[]
  noRepo: boolean
}) => {
  const { t } = useTranslation()
  const { notify } = useToast()
  const client = useGitHubClient()
  // `pending` drives the disabled state; the synchronous useSafeSubmit latch is
  // the real re-entrancy guard (React state updates a render tick late, so two
  // same-tick clicks would both pass a pending check and race duplicate shim
  // commits — the loser 422s on the non-force ref update).
  const run = useSafeSubmit()
  const [pending, setPending] = useState(false)

  const handleClick = async () => {
    if (noRepo) return
    setPending(true)
    try {
      const outcome = await updateShimSubmissionMode({
        client,
        org,
        repo,
        mode: submissionMode,
        tags: submissionTags,
      })
      notify({
        tone:
          outcome.status === "updated" || outcome.status === "current"
            ? "success"
            : "warning",
        message: t(`submissions.rowTrigger.outcome.${outcome.status}`),
      })
    } catch (err) {
      notify({
        tone: "error",
        message:
          err instanceof Error
            ? err.message
            : t("submissions.rowTrigger.outcome.failed"),
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <ActionListRow
      icon={GitBranch}
      title={t("submissions.rowTrigger.title")}
      description={t("submissions.rowTrigger.description")}
      onClick={() => void run(handleClick)}
      disabled={noRepo || pending}
      ariaLabel={t("submissions.rowTrigger.aria", { repo })}
    />
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
