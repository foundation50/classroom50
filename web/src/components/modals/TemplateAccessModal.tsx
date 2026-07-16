import { useId } from "react"
import { useTranslation } from "react-i18next"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ExternalLink, KeyRound, ShieldCheck } from "lucide-react"

import { Badge, Button, Modal, Spinner } from "@/components/ui"
import GitHub from "@/assets/github.svg?react"
import type { Assignment } from "@/types/classroom"
import type { GitHubRepoTeam } from "@/github-core/types"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useGitHubOrgRole } from "@/context/githubOrgRole/GitHubOrgRoleProvider"
import { can } from "@/authz"
import { githubKeys, repoTeamsQuery } from "@/github-core/queries"
import { useReconcileTemplateAccess } from "@/hooks/mutations/useReconcileTemplateAccess"
import { useToast } from "@/context/notifications/NotificationProvider"
import { githubTemplateRepoUrl } from "@/util/orgUrl"

// Review + fix a template's team access in one place: which template repo the
// assignment uses, which GitHub teams can read it, and (org owners only) a
// one-click re-grant of the classroom student/TA teams. Merges the former
// per-row "view source repo" link and "fix template access" button.
export const TemplateAccessModal = ({
  org,
  classroom,
  assignment,
  onClose,
}: {
  org: string
  classroom: string
  assignment: Assignment
  onClose: () => void
}) => {
  const { t } = useTranslation()
  const titleId = useId()
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { notify } = useToast()
  const { githubOrgRole } = useGitHubOrgRole()
  const isOwner = can("manageOrg", { githubOrgRole })
  const reconcile = useReconcileTemplateAccess()

  const template = assignment.template
  const inOrg = !!template && template.owner.toLowerCase() === org.toLowerCase()
  // `enabled` is false when there's no template (empty owner/repo), so the
  // hook order stays stable even for the defensive no-template case below.
  const teamsQuery = useQuery(
    repoTeamsQuery(client, template?.owner ?? "", template?.repo ?? ""),
  )

  // The modal is only opened for templated assignments; narrow defensively
  // (after all hooks, to keep hook order stable).
  if (!template) return null

  const handleFix = () => {
    reconcile.mutate(
      { org, classroom, slug: assignment.slug, template },
      {
        onSuccess: (result) => {
          if (result.warning) {
            notify({
              tone: "error",
              message: `${t("assignments.template.reconcile.failed")} ${result.warning}`,
            })
          } else {
            notify({
              tone: "success",
              message: t("assignments.template.reconcile.success"),
            })
            // Refetch the team list so a newly granted team shows up.
            void queryClient.invalidateQueries({
              queryKey: githubKeys.repoTeams(template.owner, template.repo),
            })
          }
        },
      },
    )
  }

  return (
    <Modal open onClose={onClose} size="lg" aria-labelledby={titleId}>
      <div className="flex items-start gap-4">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <ShieldCheck className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-lg font-bold">
            {t("assignments.template.accessModal.title")}
          </h3>
          <p className="mt-1 text-sm text-base-content/70">
            {t("assignments.template.accessModal.description")}
          </p>
        </div>
      </div>

      <section className="mt-5">
        <h4 className="text-sm font-semibold text-base-content/80">
          {t("assignments.template.accessModal.templateHeading")}
        </h4>
        <div className="mt-2 flex items-center justify-between gap-3 rounded-box border border-base-content/10 bg-base-200/40 px-3 py-2">
          <div className="min-w-0">
            <div className="truncate font-mono text-sm">
              {template.owner}/{template.repo}
            </div>
            <div className="text-xs text-base-content/60">
              {t("assignments.template.accessModal.branchLabel")}:{" "}
              <span className="font-mono">{template.branch}</span>
            </div>
          </div>
          <a
            href={githubTemplateRepoUrl(
              template.owner,
              template.repo,
              template.branch,
            )}
            target="_blank"
            rel="noreferrer"
            className="btn btn-sm btn-ghost shrink-0"
          >
            <GitHub aria-hidden="true" className="size-4" />
            {t("assignments.template.accessModal.openOnGitHub")}
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
        </div>
      </section>

      <section className="mt-5">
        <h4 className="text-sm font-semibold text-base-content/80">
          {t("assignments.template.accessModal.teamsHeading")}
        </h4>
        <TeamsList
          loading={teamsQuery.isPending}
          errored={teamsQuery.isError}
          teams={teamsQuery.data ?? []}
          // A non-owner sees only teams visible to their account, so an empty
          // result may be a visibility gap rather than a genuinely unshared
          // template — surface the caveat instead of "no teams".
          partialVisibility={!isOwner}
          permissionLabel={(permission) =>
            t("assignments.template.accessModal.permissionLabel", {
              permission,
            })
          }
        />
      </section>

      <div className="modal-action mt-6 items-center">
        {inOrg && !isOwner && (
          <p className="mr-auto text-xs text-base-content/60">
            {t("assignments.template.accessModal.ownerOnlyNote")}
          </p>
        )}
        <form method="dialog">
          <Button type="submit" variant="ghost" disabled={reconcile.isPending}>
            {t("assignments.template.accessModal.close")}
          </Button>
        </form>
        {inOrg && isOwner && (
          <Button
            variant="primary"
            loading={reconcile.isPending}
            loadingLabel={t("assignments.template.reconcile.pending")}
            disabled={reconcile.isPending}
            title={t("assignments.template.accessModal.fixHint")}
            onClick={handleFix}
          >
            <KeyRound aria-hidden="true" className="size-4" />
            {t("assignments.template.accessModal.fixAction")}
          </Button>
        )}
      </div>
    </Modal>
  )
}

const TeamsList = ({
  loading,
  errored,
  teams,
  partialVisibility,
  permissionLabel,
}: {
  loading: boolean
  errored: boolean
  teams: Pick<
    GitHubRepoTeam,
    "id" | "name" | "slug" | "html_url" | "permission"
  >[]
  // The viewer only sees teams visible to their account (non-owner), so an
  // empty list is inconclusive — show the visibility caveat, not "no teams".
  partialVisibility: boolean
  permissionLabel: (permission: string) => string
}) => {
  const { t } = useTranslation()

  if (loading) {
    return (
      <p className="mt-2 flex items-center gap-2 text-sm text-base-content/60">
        <Spinner size="xs" />
        {t("assignments.template.accessModal.teamsLoading")}
      </p>
    )
  }
  // A repo-teams read that failed, or (for a non-owner) returned nothing the
  // viewer can see — either way, don't claim the template is unshared.
  if (errored || (partialVisibility && teams.length === 0)) {
    return (
      <p className="mt-2 text-sm text-base-content/60">
        {t("assignments.template.accessModal.teamsUnavailable")}
      </p>
    )
  }
  if (teams.length === 0) {
    return (
      <p className="mt-2 text-sm text-base-content/60">
        {t("assignments.template.accessModal.teamsEmpty")}
      </p>
    )
  }

  return (
    <ul className="mt-2 divide-y divide-base-content/5 rounded-box border border-base-content/10">
      {teams.map((team) => (
        <li
          key={team.id}
          className="flex items-center justify-between gap-3 px-3 py-2"
        >
          <a
            href={team.html_url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate text-sm font-medium link link-hover"
          >
            {team.name}
          </a>
          <Badge tone="neutral" size="sm">
            {permissionLabel(team.permission)}
          </Badge>
        </li>
      ))}
    </ul>
  )
}

export default TemplateAccessModal
