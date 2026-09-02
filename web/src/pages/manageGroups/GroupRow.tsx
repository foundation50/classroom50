import { useTranslation } from "react-i18next"

import { Badge, Button } from "@/components/ui"
import { LinkExternalIcon, RepoIcon } from "@/components/ui/icons"
import type { GitHubUser } from "@/github-core/types"
import type { GroupTeamRef } from "@/domain/teams/groupTeams"

// One row of the groups list, read-only by design: name + counter chip, a
// quiet member-names line, and the at-a-glance status (count vs cap, repo,
// visibility, drift). Every editing control lives in the per-group manage
// dialog the trailing button opens.
export function GroupRow({
  team,
  displayName,
  members,
  maxGroupSize,
  drifted,
  repo,
  fullNameByLogin,
  onManage,
}: {
  team: GroupTeamRef
  displayName: string
  members: GitHubUser[]
  maxGroupSize?: number
  drifted: boolean
  // The group's repository: undefined while the org repo list loads (claim
  // nothing), null when no member has accepted yet, else name + link.
  repo: { name: string; htmlUrl: string } | null | undefined
  // Lowercased login -> roster full name, for the member-names summary.
  fullNameByLogin: Map<string, string>
  onManage: (team: GroupTeamRef) => void
}) {
  const { t } = useTranslation()

  const memberNames = members.map(
    (member) => fullNameByLogin.get(member.login.toLowerCase()) ?? member.login,
  )
  const membersSummary = memberNames.join(", ")

  return (
    <li className="flex items-center gap-3 p-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {/* The canonical team slug stays out of the row copy; it lives in
              the hover title for anyone who needs the exact name. */}
          <span className="font-semibold" title={team.slug}>
            {displayName}
          </span>
          <Badge ghost size="sm">
            #{team.n}
          </Badge>
          {drifted && (
            <Badge tone="warning" size="sm">
              {t("manageGroups.driftBadge")}
            </Badge>
          )}
        </div>

        {members.length === 0 ? (
          <p className="text-sm text-base-content/60">
            {t("manageGroups.noMembers")}
          </p>
        ) : (
          <p className="truncate text-sm" title={membersSummary}>
            {membersSummary}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-base-content/70">
          <span>
            {maxGroupSize !== undefined
              ? t("manageGroups.memberCountOfMax", {
                  count: members.length,
                  max: maxGroupSize,
                })
              : t("manageGroups.memberCount", { count: members.length })}
          </span>
          {repo === undefined ? null : repo ? (
            <a
              href={repo.htmlUrl}
              target="_blank"
              rel="noreferrer"
              title={repo.name}
              className="shrink-0 hover:opacity-80"
            >
              <Badge tone="success" size="sm" className="gap-1">
                <RepoIcon aria-hidden="true" className="size-3" />
                {t("manageGroups.repo.createdBadge")}
                <LinkExternalIcon aria-hidden="true" className="size-3" />
              </Badge>
            </a>
          ) : (
            <Badge
              ghost
              size="sm"
              className="gap-1 text-base-content/60"
              title={t("manageGroups.repo.noRepoHelp")}
            >
              <RepoIcon aria-hidden="true" className="size-3" />
              {t("manageGroups.repo.noRepoBadge")}
            </Badge>
          )}
          {team.privacy && (
            <Badge
              ghost
              size="sm"
              className="text-base-content/60"
              title={t("manageGroups.visibility.help")}
            >
              {t(
                team.privacy === "secret"
                  ? "manageGroups.visibility.hidden"
                  : "manageGroups.visibility.visible",
              )}
            </Badge>
          )}
        </div>
      </div>

      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        aria-label={t("manageGroups.manageAriaLabel", { name: displayName })}
        onClick={() => onManage(team)}
      >
        {t("manageGroups.manageButton")}
      </Button>
    </li>
  )
}

export default GroupRow
