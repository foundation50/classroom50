import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"

import { MarkGithubIcon, PeopleIcon } from "@/components/ui/icons"
import { Badge } from "@/components/ui"
import { Spinner } from "@/components/Spinner"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { teamMembersQuery } from "@/github-core/queries"
import useMyGroupTeam from "@/hooks/useMyGroupTeam"
import type { GitHubUser } from "@/github-core/types"

// The team-member listing carries no display name in practice (simple user
// objects); read it defensively and fold it into the profile-link title when
// GitHub does provide it.
const memberTitle = (member: GitHubUser) =>
  member.name ? `${member.name} (${member.login})` : member.login

const profileUrl = (login: string) =>
  `https://github.com/${encodeURIComponent(login)}`

const MemberAvatar = ({
  member,
  className,
}: {
  member: GitHubUser
  className: string
}) =>
  member.avatar_url ? (
    <img src={member.avatar_url} alt="" className={className} />
  ) : (
    <MarkGithubIcon
      aria-hidden="true"
      className={`${className} text-base-content/70`}
    />
  )

// Read-only teammate visibility for the viewer's own team-mode group: the
// group's display name plus its members, each linking to the member's GitHub
// profile. Deliberately view-only — management lives in GroupTeamMembersPanel.
// Two shapes:
//   - "strip": a compact one-row summary (name + avatar row) for the student
//     submission view. Loading is a small skeleton; no team or a failed read
//     renders nothing, so the submission view is never blocked on it.
//   - "list": the fuller rows (avatar + login + maintainer badge) for the
//     student assignment list's View group modal, with a quiet fallback line
//     when the members can't be resolved.
export function GroupTeamMembersReadOnly({
  org,
  classroom,
  assignment,
  variant = "list",
}: {
  org: string
  classroom: string
  assignment: string
  variant?: "strip" | "list"
}) {
  const { t } = useTranslation()
  const client = useGitHubClient()

  const {
    data: myTeam,
    isLoading: teamLoading,
    isError: teamError,
  } = useMyGroupTeam(org, classroom, assignment)
  const membersQuery = useQuery(
    teamMembersQuery(client, org, myTeam?.slug ?? ""),
  )
  const members = membersQuery.data ?? []

  const loading = teamLoading || (Boolean(myTeam) && membersQuery.isLoading)
  const failed = teamError || membersQuery.isError || (!teamLoading && !myTeam)

  if (variant === "strip") {
    if (loading) {
      return (
        <div aria-hidden="true" className="flex items-center">
          <span className="skeleton skeleton-shimmer h-8 w-48 rounded-box" />
        </div>
      )
    }
    // Quiet omission: teammate visibility is a bonus on this surface and must
    // never block or degrade the submission view.
    if (failed || !myTeam) return null
    const groupName =
      myTeam.name ||
      t("components.groupTeamMembers.defaultName", { n: myTeam.n })
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-box border border-base-300 bg-base-100 px-4 py-2.5 text-sm">
        <span className="flex items-center gap-2 font-medium">
          <PeopleIcon aria-hidden="true" className="size-4" />
          {groupName}
        </span>
        <ul className="flex flex-wrap items-center gap-1.5">
          {members.map((member) => (
            <li key={member.login} className="flex">
              <a
                href={profileUrl(member.login)}
                target="_blank"
                rel="noreferrer"
                title={memberTitle(member)}
                aria-label={memberTitle(member)}
              >
                <MemberAvatar member={member} className="size-6 rounded-full" />
              </a>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex py-6">
        <Spinner
          className="m-auto"
          label={t("components.groupTeamMembers.loading")}
        />
      </div>
    )
  }

  if (failed || !myTeam) {
    return (
      <p className="py-4 text-sm text-base-content/70">
        {t("components.groupTeamMembers.loadFailed")}
      </p>
    )
  }

  const groupName =
    myTeam.name || t("components.groupTeamMembers.defaultName", { n: myTeam.n })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <span className="flex items-center gap-2 text-sm font-medium">
          <PeopleIcon aria-hidden="true" className="size-4" />
          {groupName}
        </span>
        <span className="text-xs text-base-content/70">
          {t("components.groupTeamMembers.memberCount", {
            count: members.length,
          })}
        </span>
      </div>
      <ul className="divide-y divide-base-200 rounded-box border border-base-200">
        {members.map((member) => (
          <li
            key={member.login}
            className="flex items-center gap-3 px-4 py-2.5"
          >
            <MemberAvatar
              member={member}
              className="size-5 shrink-0 rounded-full"
            />
            <span className="min-w-0 flex-1 truncate leading-tight">
              <a
                className="link link-hover"
                href={profileUrl(member.login)}
                target="_blank"
                rel="noreferrer"
                title={memberTitle(member)}
              >
                {member.login}
              </a>
              {member.name ? (
                <span className="ms-2 text-xs text-base-content/70">
                  {member.name}
                </span>
              ) : null}
            </span>
            {member.role === "maintainer" && (
              <Badge ghost>
                {t("components.groupTeamMembers.maintainerBadge")}
              </Badge>
            )}
          </li>
        ))}
        {members.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-base-content/70">
            {t("components.groupTeamMembers.noMembers")}
          </li>
        )}
      </ul>
    </div>
  )
}

export default GroupTeamMembersReadOnly
