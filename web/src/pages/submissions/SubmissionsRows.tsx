import { GlobeIcon, RepoIcon } from "@/components/ui/icons"
import { useTranslation } from "react-i18next"

import { getName, getDisplayName, getInitials } from "@/util/students"
import { studentRepoUrl } from "@/util/studentRepo"
import Avatar from "@/components/avatar"
import { Badge, Button } from "@/components/ui"
import { nonSubmitterStatus } from "@/pages/submissions/dashboard"
import { ScoreCell } from "@/pages/submissions/ScoreCell"
import type { ScoreOverrideCapability } from "@/pages/submissions/ScoreOverrideModal"
import useGetRepoCollaborators from "@/hooks/useGetRepoCollaborators"
import { ClickableTr } from "@/lib/motionComponents"
import { isInteractiveEventTarget } from "@/util/interactiveTarget"
import type { Student } from "@/types/classroom"
import type { StudentSortMode } from "@/util/students"

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
      // The row behind this link opens the manage modal on click; never let
      // the link's click double as a row click.
      onClick={(event) => event.stopPropagation()}
    >
      <Icon className="size-4" />
    </Button>
  ) : (
    // Inert anchor rather than a native disabled button: daisyUI turns off
    // pointer events on :disabled buttons, which also suppresses the
    // explanatory tooltip and cursor. `disabled` on the anchor variant drops
    // the href and sets aria-disabled, so it can't navigate.
    <Button
      as="a"
      variant="ghost"
      size="sm"
      shape="square"
      className="cursor-not-allowed text-base-content/30 hover:bg-transparent"
      disabled
      aria-label={emptyLabel}
      title={emptyTitle}
      onClick={(event) => event.stopPropagation()}
    >
      <Icon className="size-4 opacity-50" />
    </Button>
  )

// Warning badge marking a repo that is currently PUBLIC (issue #766): the
// student's work is visible to anyone on the internet. Rendered only when
// public — private is the norm and stays unmarked to keep rows quiet.
export const PublicRepoBadge = () => {
  const { t } = useTranslation()
  return (
    <Badge
      tone="warning"
      size="sm"
      className="whitespace-nowrap"
      title={t("submissions.publicRepo.title")}
    >
      <GlobeIcon aria-hidden="true" className="size-3" />
      {t("submissions.publicRepo.badge")}
    </Badge>
  )
}

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
        <Badge
          ghost
          className="whitespace-nowrap"
          title={t("submissions.table.notAcceptedTitle")}
        >
          {t("submissions.table.notAccepted")}
          <span className="sr-only">
            {t("submissions.table.notAcceptedTitle")}
          </span>
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
        <RepoIcon aria-hidden="true" className="size-4 shrink-0" />
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

// Shared leading affordance for a group repo row: just the repo link. The
// Members action moved into the submission hub (ManageSubmissionModal), so the
// Actions cell keeps a single GitHub-repo shortcut like the individual rows.
export const GroupActionControls = ({
  repo,
  repoHref,
}: {
  repo: string
  repoHref: string
}) => {
  const { t } = useTranslation()
  return (
    <ActionIconLink
      href={repoHref}
      icon={RepoIcon}
      label={t("submissions.table.openRepoLabel", { repo })}
      title={t("submissions.table.viewRepo")}
      emptyLabel={t("submissions.table.openRepoLabel", { repo })}
      emptyTitle={t("submissions.table.viewRepo")}
    />
  )
}

// A roster student with no submission row: identity + status badge. For an
// individual assignment the caller passes the full per-repo action cluster
// (`actions`) so a non-submitter shows the same affordances as a submitter,
// disabled where inapplicable; a group non-submitter (no per-student repo)
// falls back to an em-dash.
export const NonSubmitterRow = ({
  student,
  students,
  isGroup,
  acceptedUsernames,
  onProfile,
  actions,
  onManage,
  overrideGrade,
  onEditGrade,
  thresholdFraction = null,
  nameMode = "first",
  publicRepo = false,
}: {
  student: Student
  students: Student[]
  isGroup: boolean
  acceptedUsernames?: Set<string>
  onProfile: (username: string) => void
  actions?: React.ReactNode
  // Row-level click target: the manage-submission modal, same as the actions
  // cluster's manage button. Absent (group non-submitter — no per-student
  // repo), the row renders non-clickable.
  onManage?: () => void
  // When set (individual manual-grade assignment, writable viewer), the score
  // cell offers grade entry for this not-yet-graded student. Autograded
  // assignments have no per-row value to override here, so this is manual-only.
  overrideGrade?: ScoreOverrideCapability
  // Opens the override modal for this not-yet-graded student. Called with the
  // student's username (the entry owner).
  onEditGrade?: (username: string) => void
  // The assignment's pass threshold, so the first saved grade renders with the
  // same tone the submitter row would give it.
  thresholdFraction?: number | null
  // How to format the display name — "last" ("Last, First") when the table is
  // ordered by last name, matching the submitter rows.
  nameMode?: StudentSortMode
  // Whether this student's (accepted) repo is currently public — renders the
  // warning badge beside the status chip.
  publicRepo?: boolean
}) => {
  const canGrade =
    overrideGrade?.mode === "manual" &&
    typeof overrideGrade.maxPoints === "number" &&
    !isGroup &&
    Boolean(student.username)
  const cells = (
    <>
      <td>
        <Avatar
          name={getDisplayName(student.username, students, nameMode)}
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
        <div className="flex flex-wrap items-center gap-1.5">
          <NonSubmitterStatusBadge
            username={student.username}
            isGroup={isGroup}
            acceptedUsernames={acceptedUsernames}
          />
          {publicRepo ? <PublicRepoBadge /> : null}
        </div>
      </td>
      <td>
        {canGrade ? (
          <ScoreCell
            owner={student.username}
            hasGrade={false}
            score={0}
            max={overrideGrade?.maxPoints ?? 0}
            overridden={false}
            thresholdFraction={thresholdFraction}
            onEdit={() => onEditGrade?.(student.username)}
          />
        ) : (
          "—"
        )}
      </td>
      <td>—</td>
      {/* Quarantined from the row's manage click — see the submitter row. */}
      <td onClick={(event) => event.stopPropagation()}>
        {actions ? (
          <div className="flex items-center justify-end gap-1">{actions}</div>
        ) : (
          <div className="text-end">—</div>
        )}
      </td>
    </>
  )
  // No row action -> a plain row, so the pointer cursor never lies.
  if (!onManage) return <tr className="hover:bg-base-200">{cells}</tr>
  return (
    <ClickableTr
      className="hover:bg-base-200"
      onClick={(event) => {
        if (isInteractiveEventTarget(event)) return
        onManage()
      }}
    >
      {cells}
    </ClickableTr>
  )
}

// A group repo that exists but has no submission yet: repo + members (from the
// collaborators cache) with an "awaiting submission" badge. The Actions cell is
// composed by the caller (`actions`) so this stays presentational and avoids a
// cycle with SubmissionsRowActions (#245 keeps fetching lazy).
export const GroupRepoRow = ({
  org,
  classroom,
  assignment,
  owner,
  repoName,
  students,
  actions,
  onManage,
  publicRepo = false,
}: {
  org: string
  classroom: string
  assignment: string
  owner: string
  repoName: string
  students: Student[]
  actions: React.ReactNode
  // Row-level click target: the manage-submission modal, same as the actions
  // cluster's manage button.
  onManage?: () => void
  // Whether this group repo is currently public — renders the warning badge
  // beside the status chip.
  publicRepo?: boolean
}) => {
  const { t } = useTranslation()
  const repoHref = studentRepoUrl(org, classroom, assignment, owner)
  const cells = (
    <>
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
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="warning" className="whitespace-nowrap">
            {t("submissions.table.acceptedAwaiting")}
          </Badge>
          {publicRepo ? <PublicRepoBadge /> : null}
        </div>
      </td>
      <td>—</td>
      <td>—</td>
      {/* Quarantined from the row's manage click — see the submitter row. */}
      <td onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-end gap-1">{actions}</div>
      </td>
    </>
  )
  if (!onManage) return <tr className="hover:bg-base-200">{cells}</tr>
  return (
    <ClickableTr
      className="hover:bg-base-200"
      onClick={(event) => {
        if (isInteractiveEventTarget(event)) return
        onManage()
      }}
    >
      {cells}
    </ClickableTr>
  )
}
