import { useEffect, useId, useMemo, useRef } from "react"
import { useTranslation } from "react-i18next"
import { UsersRound } from "lucide-react"

import GitHub from "@/assets/github.svg?react"
import { Badge, Modal, MonoLtr } from "@/components/ui"
import useGetRepo from "@/hooks/useGetRepo"
import useGetRepoCollaborators from "@/hooks/useGetRepoCollaborators"
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
import type { GitHubRepo } from "@/github-core/types"
import type { Student } from "@/types/classroom"

const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })

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
  latestCommitHref,
}: {
  org: string
  repo: string
  owner: string
  students: Student[]
  repoData?: GitHubRepo
  latestCommitHref?: string
}) => {
  const { t } = useTranslation()
  const { data: collaborators } = useGetRepoCollaborators(org, repo)

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
// <dialog> nesting) with the hub left open, so dismissing the editor returns
// here rather than all the way back to the table.
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
  // Group hand-off: closes the hub and opens the members modal. Individual
  // access hand-off is carried on `action.onManageAccess`.
  onManageMembers?: () => void
  // Everything SubmissionActionList needs, minus the access hand-off, which the
  // hub wraps so it closes first (below).
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
  const { data: repoData } = useGetRepo(action.org, repo, {
    enabled: action.hasRepo,
  })
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
          latestCommitHref={latestCommitHref}
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
