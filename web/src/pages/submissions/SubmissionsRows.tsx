import { UsersRound } from "lucide-react"
import { useTranslation } from "react-i18next"

import GitHub from "@/assets/github.svg?react"
import { getName, getInitials } from "@/util/students"
import { studentRepoName, studentRepoUrl } from "@/util/studentRepo"
import Avatar from "@/components/avatar"
import { Badge, Button } from "@/components/ui"
import { nonSubmitterStatus } from "@/pages/submissions/dashboard"
import useGetRepoCollaborators from "@/hooks/useGetRepoCollaborators"
import type { Student } from "@/types/classroom"

// Secondary avatar line: the GitHub login plus the section (e.g.
// "octocat · Period 3"), dropping whichever piece is missing. The login is
// omitted when `name` is empty — Avatar's primary line already falls back to
// the login there, so repeating it in the subtitle would duplicate it.
export const identitySubtitle = (
  name?: string,
  login?: string,
  section?: string,
) => {
  const showLogin = name?.trim() ? login?.trim() : undefined
  return [showLogin, section?.trim()].filter(Boolean).join(" · ") || undefined
}

type IconComponent = React.ComponentType<{ className?: string }>

// Icon action in the Actions cell: an external link when a URL is present, else
// a dimmed non-clickable button (with a "no … yet" label) to keep the row
// aligned. Both render through the shared ghost-square Button recipe.
export const ActionIconLink = ({
  href,
  icon: Icon,
  label,
  title,
  emptyLabel,
  emptyTitle,
}: {
  href: string | null | undefined
  icon: IconComponent
  label: string
  title: string
  emptyLabel: string
  emptyTitle: string
}) =>
  href ? (
    <Button
      as="a"
      variant="ghost"
      size="sm"
      shape="square"
      className="text-base-content/70"
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={title}
    >
      <Icon className="size-4" />
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      className="text-base-content/30"
      disabled
      aria-label={emptyLabel}
      title={emptyTitle}
    >
      <Icon className="size-4" />
    </Button>
  )

// Per-row status chip for a roster student with no submission: distinguishes
// accepted-but-not-submitted, never-accepted, and (group) no-group from a flat
// "Not submitted", so a teacher can nudge accepters vs chase non-accepters.
const NonSubmitterStatusBadge = ({
  username,
  isGroup,
  acceptedUsernames,
}: {
  username: string
  isGroup: boolean
  acceptedUsernames?: Set<string>
}) => {
  const { t } = useTranslation()
  const status = nonSubmitterStatus(username, { isGroup, acceptedUsernames })
  switch (status) {
    case "accepted-not-submitted":
      return (
        <Badge tone="warning" className="whitespace-nowrap">
          {t("submissions.table.acceptedAwaiting")}
        </Badge>
      )
    case "not-accepted":
      return (
        <Badge ghost className="whitespace-nowrap">
          {t("submissions.table.notAccepted")}
        </Badge>
      )
    case "no-group":
      return (
        <Badge
          ghost
          className="whitespace-nowrap"
          title={t("submissions.table.noGroupTitle")}
        >
          {t("submissions.table.noGroup")}
        </Badge>
      )
    default:
      return (
        <Badge ghost className="whitespace-nowrap">
          {t("submissions.table.notSubmitted")}
        </Badge>
      )
  }
}

// Compact group identity: shared repo + stacked avatars. Renders from the
// scores.json `usernames` snapshot and never fetches (enabled: false) to avoid a
// per-row GitHub call; reads the shared collaborators cache so avatars upgrade to
// live data once the Members modal populates it.
const MAX_VISIBLE_AVATARS = 4

export const GroupMembers = ({
  org,
  repoName,
  usernames,
  students,
  repoHref,
  repoLabel,
}: {
  org: string
  repoName: string
  usernames: string[]
  students: Student[]
  repoHref: string
  repoLabel: string
}) => {
  const { t } = useTranslation()
  // enabled: false — reads the cache the Members modal populates, never fetches.
  const { data: liveCollaborators } = useGetRepoCollaborators(org, repoName, {
    enabled: false,
  })
  const memberLogins =
    liveCollaborators && liveCollaborators.length > 0
      ? liveCollaborators.map((c) => c.login)
      : usernames

  const visible = memberLogins.slice(0, MAX_VISIBLE_AVATARS)
  const overflow = memberLogins.length - visible.length

  return (
    <div className="flex flex-col gap-2">
      <a
        className="flex items-center gap-1.5 link link-hover w-fit font-medium"
        href={repoHref}
        target="_blank"
        rel="noreferrer"
        title={t("submissions.table.openGroupRepo")}
      >
        <GitHub aria-hidden="true" className="size-4 shrink-0" />
        <span className="font-mono text-sm">{repoLabel}</span>
      </a>

      <div className="avatar-group -space-x-3">
        {visible.map((username) => {
          const name = getName(username, students)
          return (
            <div
              key={username}
              className="avatar avatar-placeholder"
              title={name ? `${name} (${username})` : username}
            >
              <div className="bg-base-200 text-primary rounded-full w-7 border-2 border-base-100">
                <span className="text-xs">
                  {getInitials(username, students) ||
                    username.at(0)?.toUpperCase()}
                </span>
              </div>
            </div>
          )
        })}

        {overflow > 0 && (
          <div
            className="avatar avatar-placeholder"
            title={memberLogins.slice(MAX_VISIBLE_AVATARS).join(", ")}
          >
            <div className="bg-neutral text-neutral-content rounded-full w-7 border-2 border-base-100">
              <span className="text-xs">+{overflow}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// Shared action cluster for a group repo: Members button (opens the manage
// modal) + the repo link. Used by both the submitted score row and the
// awaiting group-repo row so the two never drift (one recipe, one source).
export const GroupActionControls = ({
  repo,
  repoHref,
  onManage,
}: {
  repo: string
  repoHref: string
  onManage: () => void
}) => {
  const { t } = useTranslation()
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        shape="square"
        className="text-base-content/70"
        onClick={onManage}
        aria-label={t("submissions.table.membersAria")}
        title={t("submissions.table.members")}
      >
        <UsersRound aria-hidden="true" className="size-4" />
      </Button>
      <ActionIconLink
        href={repoHref}
        icon={GitHub}
        label={t("submissions.table.openRepoLabel", { repo })}
        title={t("submissions.table.viewRepo")}
        emptyLabel={t("submissions.table.openRepoLabel", { repo })}
        emptyTitle={t("submissions.table.viewRepo")}
      />
    </>
  )
}

// A roster student with no submission row: identity + status badge, plus a repo
// link when they accepted an individual assignment (a repo exists to open).
export const NonSubmitterRow = ({
  student,
  students,
  isGroup,
  acceptedUsernames,
  org,
  classroom,
  assignment,
  onProfile,
}: {
  student: Student
  students: Student[]
  isGroup: boolean
  acceptedUsernames?: Set<string>
  org: string
  classroom: string
  assignment: string
  onProfile: (username: string) => void
}) => {
  const { t } = useTranslation()
  const accepted =
    !isGroup &&
    Boolean(
      student.username &&
      acceptedUsernames?.has(student.username.toLowerCase()),
    )
  const repo = accepted
    ? studentRepoName(classroom, assignment, student.username)
    : null
  const repoHref = accepted
    ? studentRepoUrl(org, classroom, assignment, student.username)
    : null
  return (
    <tr>
      <td>
        <Avatar
          name={getName(student.username, students)}
          initials={getInitials(student.username, students)}
          github={student.username || student.email}
          subtitle={identitySubtitle(
            getName(student.username, students),
            student.username,
            student.section,
          )}
          onClick={
            student.username ? () => onProfile(student.username) : undefined
          }
        />
      </td>
      <td>
        <NonSubmitterStatusBadge
          username={student.username}
          isGroup={isGroup}
          acceptedUsernames={acceptedUsernames}
        />
      </td>
      <td>—</td>
      <td>—</td>
      <td>
        {repo && repoHref ? (
          <ActionIconLink
            href={repoHref}
            icon={GitHub}
            label={t("submissions.table.openRepoLabel", { repo })}
            title={t("submissions.table.viewRepo")}
            emptyLabel={t("submissions.table.openRepoLabel", { repo })}
            emptyTitle={t("submissions.table.viewRepo")}
          />
        ) : (
          "—"
        )}
      </td>
    </tr>
  )
}

// A group repo that exists but has no submission yet: repo + members (from the
// collaborators cache) with an "awaiting submission" badge and the shared group
// actions. Fetching is lazy — the Members modal loads collaborators on demand,
// so a class with many formed-but-unpushed groups doesn't fan out one request
// per row on mount (#245).
export const GroupRepoRow = ({
  org,
  classroom,
  assignment,
  owner,
  repoName,
  students,
  onManage,
}: {
  org: string
  classroom: string
  assignment: string
  owner: string
  repoName: string
  students: Student[]
  onManage: () => void
}) => {
  const { t } = useTranslation()
  const repoHref = studentRepoUrl(org, classroom, assignment, owner)
  return (
    <tr>
      <td>
        <GroupMembers
          org={org}
          repoName={repoName}
          usernames={[]}
          students={students}
          repoHref={repoHref}
          repoLabel={repoName}
        />
      </td>
      <td>
        <Badge tone="warning" className="whitespace-nowrap">
          {t("submissions.table.acceptedAwaiting")}
        </Badge>
      </td>
      <td>—</td>
      <td>—</td>
      <td>
        <div className="flex items-center gap-1">
          <GroupActionControls
            repo={repoName}
            repoHref={repoHref}
            onManage={onManage}
          />
        </div>
      </td>
    </tr>
  )
}
