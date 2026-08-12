import { useEffect, useId, useMemo, useRef } from "react"
import { useTranslation } from "react-i18next"
import { UsersRound } from "lucide-react"

import GitHub from "@/assets/github.svg?react"
import { Badge, Modal, MonoLtr } from "@/components/ui"
import useGetRepo from "@/hooks/useGetRepo"
import useGetRepoCollaborators from "@/hooks/useGetRepoCollaborators"
import useGetAutogradeState from "@/hooks/useGetAutogradeState"
import {
  CollaboratorIdentity,
  normalizeUsername,
  permissionFromFlags,
} from "@/components/modals/collaboratorHelpers"
import {
  SubmissionActionList,
  type SubmissionActionListProps,
} from "@/pages/submissions/SubmissionsRowActions"
import { ActionListRow } from "@/pages/submissions/actionLayout"
import { formatSubmissionDateTime } from "@/util/formatDate"
import type { GitHubRepo } from "@/github-core/types"
import type { Student } from "@/types/classroom"

const formatDateTime = formatSubmissionDateTime

// Read-only context above the action list: accept time (repo creation), last
// push, the enrolled owner's effective access, and any extra collaborators.
// Collaborators fetch lazily (only while the hub is open); the repo read is
// lifted to the modal so its default-branch tip can also link the commit
// action. Collaborators beyond the owner are hidden when there are none, so an
// individual repo with just its student shows no collaborator line while a
// group repo lists its members (one generalized case).
const SubmissionDetails = ({
  org,
  repo,
  owner,
  students,
  repoData,
  repoLoading,
  latestCommitHref,
  canPauseAutograding = false,
}: {
  org: string
  repo: string
  owner: string
  students: Student[]
  repoData?: GitHubRepo
  repoLoading?: boolean
  latestCommitHref?: string
  // Whether this assignment autogrades (owner + default-autograder). Gates the
  // read-only "Autograding" status row so it only shows where a shim exists.
  canPauseAutograding?: boolean
}) => {
  const { t } = useTranslation()
  const { data: collaborators, isLoading: collaboratorsLoading } =
    useGetRepoCollaborators(org, repo)
  const { data: autogradeState, isLoading: autogradeLoading } =
    useGetAutogradeState(org, repo, { enabled: canPauseAutograding })

  const ownerLogin = normalizeUsername(owner)
  const ownerAccess = useMemo(() => {
    const found = collaborators?.find(
      (c) => c.login.toLowerCase() === ownerLogin,
    )
    return found ? permissionFromFlags(found.permissions) : undefined
  }, [collaborators, ownerLogin])

  const otherCollaborators = useMemo(
    () =>
      (collaborators ?? [])
        .filter((c) => c.login.toLowerCase() !== ownerLogin)
        .map((c) => c.login),
    [collaborators, ownerLogin],
  )

  const rows: { label: string; value: React.ReactNode }[] = []
  if (repoData?.created_at) {
    rows.push({
      label: t("submissions.manageModal.accepted"),
      value: formatDateTime(repoData.created_at),
    })
  }
  if (repoData?.pushed_at) {
    const pushed = formatDateTime(repoData.pushed_at)
    rows.push({
      label: t("submissions.manageModal.lastPush"),
      // Hyperlink to the latest commit when we can resolve it (somewhat
      // redundant with the commit action, but a convenient jump from the time).
      value: latestCommitHref ? (
        <a
          className="link link-hover"
          href={latestCommitHref}
          target="_blank"
          rel="noreferrer"
        >
          {pushed}
        </a>
      ) : (
        pushed
      ),
    })
  }
  if (ownerAccess) {
    rows.push({
      label: t("submissions.manageModal.access"),
      value: (
        <Badge ghost>
          {t(`assignments.form.studentPermission.levels.${ownerAccess}`)}
        </Badge>
      ),
    })
  }
  // Autograding workflow state — a read-only mirror of the Pause/Resume action,
  // so a teacher can see at a glance whether grading is on. Only for autograding
  // assignments (canPauseAutograding); notGradable means no shim, so nothing to
  // show. pausedByGitHub (fork/inactivity disable) is surfaced distinctly from a
  // teacher pause since the remediation context differs.
  if (
    canPauseAutograding &&
    autogradeState &&
    autogradeState !== "notGradable"
  ) {
    rows.push({
      label: t("submissions.manageModal.autograding"),
      value:
        autogradeState === "enabled" ? (
          <Badge tone="success">
            {t("submissions.manageModal.autogradingEnabled")}
          </Badge>
        ) : (
          <Badge tone="warning">
            {t(
              autogradeState === "pausedByGitHub"
                ? "submissions.manageModal.autogradingPausedByGitHub"
                : "submissions.manageModal.autogradingPaused",
            )}
          </Badge>
        ),
    })
  }

  const loading =
    Boolean(repoLoading) ||
    collaboratorsLoading ||
    (canPauseAutograding && autogradeLoading)

  // While the repo/collaborator reads are in flight, render a skeleton in the
  // panel's shape so the section reserves its space and doesn't pop in.
  if (loading && rows.length === 0 && otherCollaborators.length === 0) {
    return (
      <div className="mt-4 rounded-box border border-base-content/10 bg-base-200/40 p-3">
        <div className="flex flex-col gap-2.5" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center justify-between gap-4">
              <span className="skeleton skeleton-shimmer h-4 w-20" />
              <span className="skeleton skeleton-shimmer h-4 w-28" />
            </div>
          ))}
        </div>
        <span className="sr-only">{t("common.loading")}</span>
      </div>
    )
  }

  if (rows.length === 0 && otherCollaborators.length === 0) return null

  return (
    <div className="mt-4 rounded-box border border-base-content/10 bg-base-200/40 p-3">
      <dl className="flex flex-col gap-1.5 text-sm">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-4"
          >
            <dt className="text-base-content/60">{row.label}</dt>
            <dd className="min-w-0 truncate text-end font-medium">
              {row.value}
            </dd>
          </div>
        ))}
        {/* Access comes from the collaborators read; if the repo rows landed
            first, hold its place with a skeleton rather than popping it in. */}
        {collaboratorsLoading && !ownerAccess ? (
          <div className="flex items-center justify-between gap-4">
            <dt className="text-base-content/60">
              {t("submissions.manageModal.access")}
            </dt>
            <dd>
              <span
                className="skeleton skeleton-shimmer inline-block h-4 w-16 align-middle"
                aria-hidden="true"
              />
            </dd>
          </div>
        ) : null}
        {/* Autograding status lands from its own read; hold its place with a
            skeleton if the other rows resolved first. */}
        {canPauseAutograding && autogradeLoading && !autogradeState ? (
          <div className="flex items-center justify-between gap-4">
            <dt className="text-base-content/60">
              {t("submissions.manageModal.autograding")}
            </dt>
            <dd>
              <span
                className="skeleton skeleton-shimmer inline-block h-4 w-16 align-middle"
                aria-hidden="true"
              />
            </dd>
          </div>
        ) : null}
      </dl>
      {otherCollaborators.length > 0 ? (
        <div className="mt-2 border-t border-base-content/10 pt-2">
          <p className="mb-1 text-sm text-base-content/60">
            {t("submissions.manageModal.collaborators", {
              count: otherCollaborators.length,
            })}
          </p>
          <ul className="flex flex-col gap-1">
            {otherCollaborators.map((login) => (
              <li key={login} className="min-w-0">
                <CollaboratorIdentity login={login} students={students} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

// The submission hub: one entry point that gathers every per-submission action
// behind the row's Manage control. It shows the identity + repo it acts on,
// read-only context (accept/push time, access, collaborators), then the action
// list. The rich access/members editors open stacked on top of the hub (native
// <dialog> nesting). The hub's <dialog> stays open so dismissing the editor
// returns here rather than all the way back to the table, but its box is hidden
// (`subModalOpen`) while the editor is up so the two boxes don't visibly stack.
//
// Mounted only while a row is selected (the caller gates + remounts via `key`),
// so it opens once on mount; Esc/backdrop/X fire onClose to clear the selection.
export const ManageSubmissionModal = ({
  onClose,
  title,
  subtitle,
  repo,
  repoHref,
  isGroup,
  students,
  subModalOpen = false,
  onManageMembers,
  action,
}: {
  onClose: () => void
  // The submission's display name (student name) or, for a group, the repo name.
  title: string
  // Secondary line under the title (e.g. GitHub login · section), when known.
  subtitle?: string
  repo: string
  repoHref?: string
  isGroup: boolean
  // Roster, for resolving collaborator display names in the details section.
  students: Student[]
  // True while a stacked editor (access/members) is presented. The hub stays
  // open underneath (so closing the editor returns here) but hides its own box
  // to avoid visibly layered modals.
  subModalOpen?: boolean
  // Opens the group members editor stacked on the hub.
  onManageMembers?: () => void
  // Everything SubmissionActionList needs, minus the access hand-off, which the
  // hub wraps (below).
  action: Omit<SubmissionActionListProps, "onManageAccess"> & {
    onManageAccess?: () => void
  }
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()
  const { t } = useTranslation()

  // Lifted here (not in SubmissionDetails) so the repo's default-branch tip can
  // link both the "Last push" row and the "View latest commit" action. Only
  // fetched once the hub is open; skipped entirely when no repo exists yet.
  const { data: repoData, isLoading: repoLoading } = useGetRepo(
    action.org,
    repo,
    {
      enabled: action.hasRepo,
    },
  )
  const latestCommitHref =
    repoData?.html_url && repoData.default_branch
      ? `${repoData.html_url}/commit/${repoData.default_branch}`
      : undefined

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  // Open the access/members editor stacked on top of the hub (native <dialog>
  // supports nesting). We intentionally leave the hub open so dismissing the
  // editor returns here rather than all the way back to the table.
  const handleManageAccess = () => {
    action.onManageAccess?.()
  }

  const handleManageMembers = () => {
    onManageMembers?.()
  }

  return (
    <Modal
      dialogRef={dialogRef}
      onClose={onClose}
      size="lg"
      // Keep the dialog open but hide its box while a stacked editor is up, so
      // the two modal boxes don't visibly layer. The editor renders its own
      // backdrop on top; dismissing it un-hides this box.
      boxClassName={subModalOpen ? "invisible" : undefined}
      aria-labelledby={titleId}
    >
      <h3 id={titleId} className="truncate pe-8 text-lg font-bold">
        {title}
      </h3>
      {subtitle ? (
        <p className="mt-0.5 truncate text-sm text-base-content/60">
          {subtitle}
        </p>
      ) : null}
      {repoHref ? (
        <a
          className="link link-hover mt-2 inline-flex w-fit max-w-full items-center gap-1.5"
          href={repoHref}
          target="_blank"
          rel="noreferrer"
          title={t("submissions.table.viewRepo")}
        >
          <GitHub aria-hidden="true" className="size-4 shrink-0" />
          <MonoLtr className="truncate text-sm">{repo}</MonoLtr>
        </a>
      ) : (
        <p className="mt-2 inline-flex w-fit max-w-full items-center gap-1.5 text-base-content/50">
          <GitHub aria-hidden="true" className="size-4 shrink-0" />
          <MonoLtr className="truncate text-sm">{repo}</MonoLtr>
        </p>
      )}

      {action.hasRepo ? (
        <SubmissionDetails
          org={action.org}
          repo={repo}
          owner={action.owner}
          students={students}
          repoData={repoData ?? undefined}
          repoLoading={repoLoading}
          latestCommitHref={latestCommitHref}
          canPauseAutograding={action.canPauseAutograding}
        />
      ) : null}

      <div className="mt-4 divide-y divide-base-200">
        <SubmissionActionList
          {...action}
          latestCommitHref={latestCommitHref}
          onManageAccess={
            action.onManageAccess ? handleManageAccess : undefined
          }
        />
        {isGroup && onManageMembers ? (
          <ActionListRow
            icon={UsersRound}
            title={t("submissions.table.members")}
            description={t("submissions.manageModal.membersDescription")}
            onClick={handleManageMembers}
          />
        ) : null}
      </div>
    </Modal>
  )
}

export default ManageSubmissionModal
