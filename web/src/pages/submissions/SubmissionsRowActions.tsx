import {
  DownloadIcon,
  GitBranchIcon,
  GitCommitIcon,
  GlobeIcon,
  LockIcon,
  LogIcon,
  PauseIcon,
  PlayIcon,
  RepoIcon,
  ShieldCheckIcon,
  SlidersIcon,
  SyncIcon,
} from "@/components/ui/icons"
import { useState } from "react"
import { Trans, useTranslation } from "react-i18next"

import { safeHttpUrl } from "@/util/url"
import { Button, EmphasisLtr } from "@/components/ui"
import { ConfirmModal } from "@/components/modals"
import { ActionIconLink } from "@/pages/submissions/SubmissionsRows"
import { ActionListRow } from "@/pages/submissions/actionLayout"
import { ReviewButton } from "@/pages/submissions/ReviewButton"
import useTriggerRegrade from "@/hooks/useTriggerRegrade"
import useDownloadSubmission from "@/hooks/mutations/useDownloadSubmission"
import useGetAutogradeState from "@/hooks/useGetAutogradeState"
import useSetAutogradeState from "@/hooks/mutations/useSetAutogradeState"
import useSetRepoVisibility from "@/hooks/mutations/useSetRepoVisibility"
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
        icon={SyncIcon}
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
        icon={SyncIcon}
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
      icon={DownloadIcon}
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
// non-submitter, group). It now holds a small set of shortcuts: the leading
// Open-repo link (`header`), a direct "View autograder details" link to the
// latest submission release (a teacher's most common jump, so it skips the hub),
// and a single Manage trigger that opens the submission hub
// (ManageSubmissionModal), where every other action — commit, Review, access,
// regrade, download — lives as a labeled row. Keeping the dense table to these
// few shortcuts plus one entry point scales as we add actions, instead of a
// growing icon cluster.
export const RepoRowActions = ({
  owner,
  header,
  feedbackPr,
  release,
  skipsGrading = false,
  onManage,
}: {
  owner: string
  // The leading affordance for this row family (Open-repo link for individuals,
  // repo link for groups).
  header: React.ReactNode
  // The direct Feedback-PR shortcut (FeedbackPrIconButton), rendered right
  // after the repo link (issue #741). Omitted for empty_repo assignments,
  // which have no Feedback PR — mirrors the hub's Review gate.
  feedbackPr?: React.ReactNode
  // The submission's latest release page (autograder result). When present, a
  // direct "View autograder details" shortcut links it (skipping the hub). The
  // shortcut is hidden when there's no result to view — before a submission
  // lands, or for assignments that skip built-in grading (see skipsGrading).
  release?: string | null
  // The assignment skips built-in grading (empty_repo OR no_autograder): there's
  // no autograder result, so the details shortcut is hidden entirely.
  skipsGrading?: boolean
  // Opens the submission hub for this row.
  onManage: () => void
}) => {
  const { t } = useTranslation()
  const releaseHref = skipsGrading ? null : safeHttpUrl(release)
  return (
    <>
      {header}
      {feedbackPr}
      {releaseHref && (
        <ActionIconLink
          href={releaseHref}
          icon={LogIcon}
          label={t("submissions.table.viewDetails")}
          title={t("submissions.table.viewDetails")}
          emptyLabel={t("submissions.table.viewDetails")}
          emptyTitle={t("submissions.table.viewDetails")}
        />
      )}
      <Button
        variant="ghost"
        size="sm"
        shape="square"
        className="text-base-content/70"
        onClick={(event) => {
          event.stopPropagation()
          onManage()
        }}
        aria-label={t("submissions.manageModal.openAria", { owner })}
        title={t("submissions.manageModal.open")}
      >
        <SlidersIcon aria-hidden="true" className="size-4" />
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
// (commit, details) dim until an attempt lands. Two distinct omission gates:
// assignments that skip built-in grading (empty_repo OR no_autograder —
// skipsGrading) omit the grading actions (details/regrade), while only a bare
// empty_repo also omits the repo actions (Review/access) — a no_autograder
// repo is templated and keeps the Feedback PR, matching the page's bulk gates.
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
  // The assignment never autogrades (empty_repo OR no_autograder).
  skipsGrading: boolean
  // The narrower bare-repo case (empty_repo alone).
  emptyRepoAssignment: boolean
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
  // Whether the Pause/Resume-autograding action applies: owner + a gradable
  // default-autograder assignment (same gate as submissionMode). Omitted/false
  // hides the action — a non-owner can't disable workflows, and there's no
  // autograde workflow to pause on empty_repo/no_autograder/custom assignments.
  canPauseAutograding?: boolean
  // Whether the Change-visibility action applies: owner-only (org policy
  // blocks members from flipping visibility; GitHub 403s them regardless).
  // Applies to every repo shape — a bare or group repo is still a repo whose
  // work a teacher may showcase (issue #766).
  canChangeVisibility?: boolean
  // The repo's live private flag (from the hub's repo read), driving the
  // Change-visibility action's label/direction. undefined = still loading.
  repoPrivate?: boolean
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
  skipsGrading,
  emptyRepoAssignment,
  displayName,
  onManageAccess,
  submissionMode,
  submissionTags,
  canPauseAutograding = false,
  canChangeVisibility = false,
  repoPrivate,
}: SubmissionActionListProps) => {
  const { t } = useTranslation()
  const commitHref = latestCommitHref ?? safeHttpUrl(commit)
  const releaseHref = safeHttpUrl(release)
  return (
    <div className="flex flex-col">
      <ActionListRow
        icon={GitCommitIcon}
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
      {/* Repo actions: any templated repo (incl. no_autograder) keeps the
          Feedback PR and is worth managing; only a bare empty_repo omits them. */}
      {!emptyRepoAssignment && (
        <>
          <ReviewButton org={org} repo={repo} mode={mode} noRepo={!hasRepo} />
          {onManageAccess && (
            <ActionListRow
              icon={ShieldCheckIcon}
              title={t("submissions.table.manageAccess")}
              description={t("submissions.manageModal.accessDescription")}
              onClick={onManageAccess}
              disabled={!hasRepo}
              ariaLabel={t("submissions.table.manageAccessAria", { owner })}
            />
          )}
        </>
      )}
      {/* Grading actions: no submit/* releases exist when grading is skipped,
          so there's nothing to view or regrade. */}
      {!skipsGrading && (
        <>
          <ActionListRow
            icon={LogIcon}
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
          {canPauseAutograding && (
            <PauseAutogradingButton org={org} repo={repo} noRepo={!hasRepo} />
          )}
        </>
      )}
      {canChangeVisibility && (
        <ChangeVisibilityButton
          org={org}
          repo={repo}
          isPrivate={repoPrivate}
          displayName={displayName || owner}
          noRepo={!hasRepo}
        />
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
      icon={GitBranchIcon}
      title={t("submissions.rowTrigger.title")}
      description={t("submissions.rowTrigger.description")}
      onClick={() => void run(handleClick)}
      disabled={noRepo || pending}
      ariaLabel={t("submissions.rowTrigger.aria", { repo })}
    />
  )
}

// Per-row Change visibility (issue #766): flip this one repo between private
// and public — e.g. showcase a stand-out final project, or revert one. The
// direction follows the repo's live private flag; going PUBLIC confirms first
// (student work can carry names/emails not meant to be public), while going
// back private applies immediately (strictly less exposure).
const ChangeVisibilityButton = ({
  org,
  repo,
  isPrivate,
  displayName,
  noRepo,
}: {
  org: string
  repo: string
  // The repo's live private flag; undefined while the read is pending, which
  // disables the action (never fire against a guessed direction).
  isPrivate?: boolean
  displayName: string
  noRepo: boolean
}) => {
  const { t } = useTranslation()
  const { notify } = useToast()
  const run = useSafeSubmit()
  const mutation = useSetRepoVisibility()
  const [confirmOpen, setConfirmOpen] = useState(false)

  const stateUnknown = !noRepo && isPrivate === undefined
  const makePublic = isPrivate !== false

  const apply = async () => {
    try {
      await mutation.mutateAsync({
        org,
        repo,
        visibility: makePublic ? "public" : "private",
      })
      notify({
        tone: "success",
        message: t(
          makePublic
            ? "submissions.rowVisibility.outcome.public"
            : "submissions.rowVisibility.outcome.private",
          { repo },
        ),
      })
    } catch (err) {
      notify({
        tone: "error",
        message:
          err instanceof Error
            ? err.message
            : t("submissions.rowVisibility.outcome.failed"),
      })
    }
  }

  const handleClick = () => {
    if (noRepo || stateUnknown || mutation.isPending) return
    if (makePublic) {
      setConfirmOpen(true)
      return
    }
    void run(apply)
  }

  return (
    <>
      <ActionListRow
        icon={makePublic ? GlobeIcon : LockIcon}
        title={t(
          makePublic
            ? "submissions.rowVisibility.makePublicTitle"
            : "submissions.rowVisibility.makePrivateTitle",
        )}
        description={t(
          makePublic
            ? "submissions.rowVisibility.makePublicDescription"
            : "submissions.rowVisibility.makePrivateDescription",
        )}
        onClick={handleClick}
        disabled={noRepo || stateUnknown || mutation.isPending}
        loading={stateUnknown || mutation.isPending}
        loadingLabel={t("submissions.rowVisibility.makePublicTitle")}
        ariaLabel={t(
          makePublic
            ? "submissions.rowVisibility.makePublicAria"
            : "submissions.rowVisibility.makePrivateAria",
          { repo },
        )}
      />
      <ConfirmModal
        open={confirmOpen}
        title={t("submissions.rowVisibility.confirmTitle", {
          name: displayName,
        })}
        description={
          <Trans
            i18nKey="submissions.rowVisibility.confirmBody"
            values={{ repo }}
            components={{ repo: <EmphasisLtr className="font-normal" /> }}
          />
        }
        confirmLabel={t("submissions.rowVisibility.confirmLabel")}
        cancelLabel={t("common.cancel")}
        dangerous
        needsConfirm={false}
        onConfirm={apply}
        onClose={() => setConfirmOpen(false)}
      />
    </>
  )
}

// Per-row Pause/Resume autograding. Flips the autograde workflow's GitHub
// Actions state (disable/enable) WITHOUT editing the shim file. The label and
// icon follow the repo's live state — Pause when enabled, Resume when paused —
// and fall back to a neutral "Pause autograding" while the state read is
// pending or failed (unknown), where a click reads state implicitly: pausing an
// already-paused workflow is an idempotent no-op, so the fallback stays safe.
const PauseAutogradingButton = ({
  org,
  repo,
  noRepo,
}: {
  org: string
  repo: string
  noRepo: boolean
}) => {
  const { t } = useTranslation()
  const { notify } = useToast()
  const run = useSafeSubmit()
  const {
    data: state,
    isLoading: stateLoading,
    isError: stateError,
  } = useGetAutogradeState(org, repo, { enabled: !noRepo })
  const mutation = useSetAutogradeState()

  // No autograde workflow (empty_repo/no_autograder/custom, or deleted): nothing
  // to pause. The parent already gates on a default-autograder assignment, so
  // this only fires for a stray repo without the shim — hide the action.
  if (!noRepo && state === "notGradable") return null

  // Paused (by teacher or by GitHub) → offer Resume; otherwise → offer Pause.
  const isPaused = state === "paused" || state === "pausedByGitHub"
  const action: "pause" | "resume" = isPaused ? "resume" : "pause"

  // The label defaults to Pause when the state is unknown; disable the action
  // until the state resolves (and if the read failed) so we never mislabel a
  // GitHub-disabled repo as "enabled" or fire an action against a guessed state.
  const stateUnknown = !noRepo && (stateLoading || stateError || state == null)

  const handleClick = async () => {
    if (noRepo) return
    try {
      const result = await mutation.mutateAsync({ org, repo, action })
      notify({
        tone: result.status === "notGradable" ? "warning" : "success",
        message: t(
          result.status === "notGradable"
            ? "submissions.rowAutograde.outcome.notGradable"
            : action === "pause"
              ? "submissions.rowAutograde.outcome.paused"
              : "submissions.rowAutograde.outcome.resumed",
        ),
      })
    } catch (err) {
      notify({
        tone: "error",
        message:
          err instanceof Error
            ? err.message
            : t("submissions.rowAutograde.outcome.failed"),
      })
    }
  }

  return (
    <ActionListRow
      icon={isPaused ? PlayIcon : PauseIcon}
      title={t(
        isPaused
          ? "submissions.rowAutograde.resumeTitle"
          : "submissions.rowAutograde.pauseTitle",
      )}
      description={t(
        isPaused
          ? "submissions.rowAutograde.resumeDescription"
          : "submissions.rowAutograde.pauseDescription",
      )}
      onClick={() => void run(handleClick)}
      disabled={noRepo || stateUnknown || mutation.isPending}
      loading={stateUnknown}
      loadingLabel={t("submissions.rowAutograde.pauseTitle")}
      ariaLabel={t(
        isPaused
          ? "submissions.rowAutograde.resumeAria"
          : "submissions.rowAutograde.pauseAria",
        { repo },
      )}
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
      icon={RepoIcon}
      label={t("submissions.table.openRepoLabel", { repo })}
      title={t("submissions.table.viewRepo")}
      emptyLabel={t("submissions.table.openRepoLabel", { repo })}
      emptyTitle={t("submissions.table.noRepoYetTitle")}
    />
  )
}
