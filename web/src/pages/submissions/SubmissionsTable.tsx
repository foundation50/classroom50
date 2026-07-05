import {
  ChevronRight,
  GitCommitHorizontal,
  MessageCircle,
  RefreshCw,
  ScrollText,
  UsersRound,
} from "lucide-react"
import { Fragment, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import GitHub from "@/assets/github.svg?react"
import {
  getName,
  getInitials,
  getSection,
  resolveStudent,
} from "@/util/students"
import { studentRepoName, studentRepoUrl } from "@/util/studentRepo"
import { safeHttpUrl } from "@/util/url"
import Avatar from "@/components/avatar"
import { ConfirmModal } from "@/components/modals"
import { GroupCollaboratorsModal } from "@/components/modals/GroupCollaboratorsModal"
import { StudentProfileModal } from "@/components/modals/StudentProfileModal"
import type { SubmissionAttempt, SubmissionRow } from "@/hooks/useGetScores"
import useGetFeedbackPr from "@/hooks/useGetFeedbackPr"
import useGetRepoCollaborators from "@/hooks/useGetRepoCollaborators"
import useTriggerRegrade from "@/hooks/useTriggerRegrade"
import type { Student } from "@/types/classroom"
import { EnterDiv } from "@/lib/motionComponents"

const formatDateTime = (datetime: string) =>
  new Date(datetime).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })

// Secondary avatar line: the GitHub login plus the section (e.g.
// "octocat · Period 3"), dropping whichever piece is missing. The login is
// omitted when `name` is empty — Avatar's primary line already falls back to
// the login there, so repeating it in the subtitle would duplicate it.
const identitySubtitle = (name?: string, login?: string, section?: string) => {
  const showLogin = name?.trim() ? login?.trim() : undefined
  return [showLogin, section?.trim()].filter(Boolean).join(" · ") || undefined
}

// Badge color from the assignment's pass threshold: green at/above the bar, red
// below, neutral when ungraded (max 0) or no threshold (`null`).
const scoreToBadgeType = (
  score: number,
  max: number,
  thresholdFraction: number | null,
) => {
  if (thresholdFraction == null || !max) return "badge-ghost"
  return score / max >= thresholdFraction ? "badge-success" : "badge-error"
}

// Icon action in the Actions cell: an external link when a URL is present, else
// a dimmed non-clickable span (with a "no … yet" label) to keep the row aligned.
type IconComponent = React.ComponentType<{ className?: string }>

const ACTION_BTN = "btn btn-ghost btn-sm btn-square"

const ActionIconLink = ({
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
    <a
      className={`${ACTION_BTN} text-base-content/70`}
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={title}
    >
      <Icon className="size-4" />
    </a>
  ) : (
    <span
      className={`${ACTION_BTN} text-base-content/30`}
      aria-label={emptyLabel}
      title={emptyTitle}
    >
      <Icon className="size-4" />
    </span>
  )

// Inline commit/details link in the expanded history row: external link when a
// URL is present, else dimmed non-clickable text (label shown beside the icon,
// unlike the icon-only row-action above).
const HistoryLink = ({
  href,
  icon: Icon,
  label,
}: {
  href: string | null | undefined
  icon: IconComponent
  label: string
}) =>
  href ? (
    <a
      className="link link-hover inline-flex items-center gap-1"
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      <Icon className="size-3.5" />
      {label}
    </a>
  ) : (
    <span className="inline-flex items-center gap-1 text-base-content/70">
      <Icon className="size-3.5" />
      {label}
    </span>
  )

// Compact group identity: shared repo + stacked avatars. Renders from the
// scores.json `usernames` snapshot and never fetches (enabled: false) to avoid a
// per-row GitHub call; reads the shared collaborators cache so avatars upgrade to
// live data once the Members modal populates it.
const MAX_VISIBLE_AVATARS = 4

const GroupMembers = ({
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

// Review action: links to the open Feedback PR (opened by the autograde
// workflow) when one exists, else opens an info modal. The PR is the source of
// truth. The /pulls lookup is deferred until Review is clicked (an eager per-row
// query would fan out to one request per repo on mount); on click we refetch.
const ReviewButton = ({ org, repo }: { org: string; repo: string }) => {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()
  const [resolving, setResolving] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // enabled: false — driven by refetch() on click, never on mount.
  const { refetch } = useGetFeedbackPr(org, repo, false)

  const handleReview = async () => {
    setResolving(true)
    try {
      // getOpenPullRequests maps 404 -> [], so a non-404 failure surfaces as
      // `error`; show it rather than the misleading "no PR yet" message.
      const { data: pr, error } = await refetch()
      if (error) {
        setErrorMsg(error instanceof Error ? error.message : String(error))
        dialogRef.current?.showModal()
      } else if (pr) {
        window.open(pr.html_url, "_blank", "noopener,noreferrer")
      } else {
        setErrorMsg(null)
        dialogRef.current?.showModal()
      }
    } finally {
      setResolving(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm btn-square text-base-content/70 disabled:opacity-60"
        disabled={resolving}
        onClick={handleReview}
        aria-label={t("submissions.table.reviewAria")}
        title={t("submissions.table.review")}
      >
        {resolving ? (
          <span
            className="loading loading-spinner loading-xs"
            aria-hidden="true"
          />
        ) : (
          <MessageCircle aria-hidden="true" className="size-4" />
        )}
      </button>
      <dialog ref={dialogRef} className="modal" aria-labelledby={titleId}>
        <div className="modal-box max-w-md">
          {errorMsg ? (
            <>
              <h3 id={titleId} className="text-lg font-bold">
                {t("submissions.reviewModal.errorTitle")}
              </h3>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-base-content/70">
                {errorMsg}
              </p>
            </>
          ) : (
            <>
              <h3 id={titleId} className="text-lg font-bold">
                {t("submissions.reviewModal.emptyTitle")}
              </h3>
              <p className="mt-2 text-sm leading-6 text-base-content/70">
                {t("submissions.reviewModal.emptyBody_prefix")}{" "}
                <span className="font-mono">{repo}</span>{" "}
                {t("submissions.reviewModal.emptyBody_suffix")}
              </p>
            </>
          )}
          <div className="modal-action">
            <a
              className="btn btn-ghost btn-sm"
              href={`https://github.com/${org}/${repo}/pulls`}
              target="_blank"
              rel="noreferrer"
            >
              {t("submissions.reviewModal.openRepoPrs")}
            </a>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => dialogRef.current?.close()}
            >
              {t("common.close")}
            </button>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop">
          <button>{t("common.close")}</button>
        </form>
      </dialog>
    </>
  )
}

// Per-row regrade: dispatches regrade.yaml scoped to one owner, tracked via
// useTriggerRegrade (icon shows progress; disabled while any regrade is in
// flight). Only kicks off grading — the gradebook refreshes on the next collect.
const RegradeButton = ({
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
  // The student's display name (individual assignments) when known; falls back
  // to `owner`. Omitted for group repos (owner is the founder/group).
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
      <button
        type="button"
        className={`${ACTION_BTN} text-base-content/70 disabled:opacity-60`}
        disabled={inFlight || blocked}
        onClick={handleClick}
        aria-label={t("submissions.rowRegrade.aria", { owner })}
        title={title}
      >
        {inFlight ? (
          <span
            className="loading loading-spinner loading-xs"
            aria-hidden="true"
          />
        ) : (
          <RefreshCw
            aria-hidden="true"
            className={`size-4 ${phase === "completed" ? "text-success" : phase === "failed" ? "text-error" : ""}`}
          />
        )}
      </button>
      <ConfirmModal
        open={confirmOpen}
        title={t("submissions.rowRegrade.confirmTitle", {
          name: displayName || owner,
        })}
        description={
          <>
            {t("submissions.rowRegrade.confirmBody1_prefix")}{" "}
            <span className="font-semibold text-base-content">
              {displayName || owner}
            </span>
            {displayName ? ` (${owner})` : ""}
            {t("submissions.rowRegrade.confirmBody1_suffix")}
            <br />
            <br />
            {t("submissions.rowRegrade.confirmBody2_prefix")}{" "}
            <span className="font-semibold">
              {t("submissions.collect.label")}
            </span>{" "}
            {t("submissions.rowRegrade.confirmBody2_suffix")}
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

// Expanded per-row history: every submission for a repo, newest first.
const SubmissionHistory = ({
  submissions,
  repoHref,
  isGroup,
  students,
  thresholdFraction,
}: {
  submissions: SubmissionAttempt[]
  repoHref: string
  isGroup: boolean
  students: Student[]
  thresholdFraction: number | null
}) => {
  const { t } = useTranslation()
  return (
    <ol className="flex flex-col gap-2">
      {submissions.map((s, i) => (
        <li
          key={`${s.datetime}-${s.commit}`}
          className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-box border border-base-content/5 bg-base-100 px-3 py-2 text-sm"
        >
          <span className="text-base-content/70 w-6 shrink-0">
            #{submissions.length - i}
          </span>
          <span className="w-44 shrink-0">{formatDateTime(s.datetime)}</span>
          <span
            className={`badge badge-soft badge-sm ${scoreToBadgeType(s.score, s["max-score"], thresholdFraction)}`}
          >
            {s.score}/{s["max-score"]}
          </span>
          {s.late ? (
            <span
              className="badge badge-sm badge-error badge-soft"
              title={t("submissions.table.lateHistoryTitle")}
            >
              {t("submissions.table.late")}
            </span>
          ) : null}
          {isGroup && s.submittedBy ? (
            <span className="text-base-content/70">
              {t("submissions.table.submittedBy", {
                name: getName(s.submittedBy, students) || s.submittedBy,
              })}
            </span>
          ) : null}
          <span className="ml-auto flex gap-3">
            <HistoryLink
              href={safeHttpUrl(s.commit)}
              icon={GitCommitHorizontal}
              label={t("submissions.table.commit")}
            />
            <HistoryLink
              href={safeHttpUrl(s.release)}
              icon={ScrollText}
              label={t("submissions.table.details")}
            />
          </span>
        </li>
      ))}
      <li className="text-xs text-base-content/70">
        {t("submissions.table.fullHistory_prefix")}{" "}
        <a className="link" href={repoHref} target="_blank" rel="noreferrer">
          {t("submissions.table.fullHistory_link")}
        </a>{" "}
        {t("submissions.table.fullHistory_suffix")}
      </li>
    </ol>
  )
}

const SubmissionsTable = ({
  scores,
  students,
  nonSubmitters = [],
  isGroup = false,
  org,
  classroom,
  assignment,
  assignmentName,
  maxGroupSize,
  acceptedUsernames,
  thresholdFraction,
}: {
  scores: SubmissionRow[]
  students: Student[]
  nonSubmitters?: Student[]
  isGroup?: boolean
  org: string
  classroom: string
  assignment: string
  assignmentName?: string
  maxGroupSize?: number
  // Lowercased usernames with an assignment repo (individual assignments). Used
  // to decide whether the profile modal shows "Open repo" for a non-submitter —
  // a never-accepted student has no repo, so the link would 404.
  acceptedUsernames?: Set<string>
  // Passing bar as a fraction of max (e.g. 1.0 = full marks); drives score badge
  // color. `null`/omitted means no passing threshold (badges render neutral).
  thresholdFraction?: number | null
}) => {
  const { t } = useTranslation()
  const passBar = thresholdFraction ?? null
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const toggle = (owner: string) =>
    setExpanded((prev) => ({ ...prev, [owner]: !prev[owner] }))

  // The owner (group founder) whose collaborators modal is open, or null.
  const [manageOwner, setManageOwner] = useState<string | null>(null)

  // The student whose profile modal is open (resolved from a row's username), or
  // null. Resolves to a roster Student for the richer detail view.
  const [profileUsername, setProfileUsername] = useState<string | null>(null)
  const profileStudent = profileUsername
    ? resolveStudent(profileUsername, students)
    : null

  // The profiled student has a repo iff they submitted (login credited on a
  // score row) or accepted (in acceptedUsernames). A never-accepted non-submitter
  // has none, so we omit the modal's repo link rather than point it at a 404.
  const profileHasRepo = (() => {
    if (!profileUsername) return false
    const login = profileUsername.toLowerCase()
    if (acceptedUsernames?.has(login)) return true
    return scores.some((row) =>
      row.usernames.some((u) => u.toLowerCase() === login),
    )
  })()

  return (
    <>
      <EnterDiv className="overflow-x-auto rounded-box border border-base-content/5 bg-base-100">
        <table className="table">
          <caption className="sr-only">
            {isGroup
              ? t("submissions.table.captionGroup")
              : t("submissions.table.captionStudent")}
          </caption>
          <thead>
            <tr>
              <th scope="col">
                {isGroup
                  ? t("submissions.table.colGroup")
                  : t("submissions.table.colStudent")}
              </th>
              <th scope="col">{t("submissions.table.colSubmissions")}</th>
              <th scope="col">{t("submissions.table.colScore")}</th>
              <th scope="col">{t("submissions.table.colLastSubmitted")}</th>
              <th scope="col">{t("submissions.table.colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {!scores?.length && !nonSubmitters.length && (
              <tr>
                <td colSpan={5} className="text-center text-base-content/70">
                  {t("submissions.table.emptyState")}
                </td>
              </tr>
            )}
            {scores.map(
              ({
                usernames,
                score,
                datetime,
                submissionCount,
                late,
                ...rest
              }) => {
                const repo = studentRepoName(classroom, assignment, rest.owner)
                const repoHref = studentRepoUrl(
                  org,
                  classroom,
                  assignment,
                  rest.owner,
                )
                const canExpand = submissionCount > 1
                const isOpen = !!expanded[rest.owner]
                return (
                  <Fragment key={rest.owner}>
                    <tr>
                      <td>
                        {isGroup ? (
                          <GroupMembers
                            org={org}
                            repoName={repo}
                            usernames={usernames}
                            students={students}
                            repoHref={repoHref}
                            repoLabel={repo}
                          />
                        ) : (
                          <Avatar
                            name={getName(usernames[0], students)}
                            initials={getInitials(usernames[0], students)}
                            github={usernames[0]}
                            subtitle={identitySubtitle(
                              getName(usernames[0], students),
                              usernames[0],
                              getSection(usernames[0], students),
                            )}
                            onClick={() => setProfileUsername(usernames[0])}
                          />
                        )}
                      </td>
                      <td>
                        {canExpand ? (
                          <button
                            type="button"
                            className="badge max-xl:text-xs whitespace-nowrap gap-1 hover:badge-neutral cursor-pointer"
                            aria-expanded={isOpen}
                            title={
                              isOpen
                                ? t("submissions.table.hideSubmissions")
                                : t("submissions.table.showSubmissions")
                            }
                            onClick={() => toggle(rest.owner)}
                          >
                            <ChevronRight
                              aria-hidden="true"
                              className={`size-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`}
                            />
                            {t("submissions.table.submissionCount", {
                              count: submissionCount,
                            })}
                          </button>
                        ) : (
                          <label className="badge max-xl:text-xs whitespace-nowrap">
                            {t("submissions.table.submissionCount", {
                              count: submissionCount,
                            })}
                          </label>
                        )}
                      </td>
                      <td>
                        <label
                          className={`badge badge-soft ${scoreToBadgeType(score, rest["max-score"], passBar)}`}
                        >
                          {score}/{rest["max-score"]}
                        </label>
                      </td>
                      <td>
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className="whitespace-nowrap">
                              {formatDateTime(datetime)}
                            </span>
                            {late ? (
                              <span
                                className="badge badge-sm badge-error badge-soft"
                                title={t("submissions.table.lateRowTitle")}
                              >
                                {t("submissions.table.late")}
                              </span>
                            ) : null}
                          </div>
                          {rest.gradedAt && rest.gradedAt !== datetime ? (
                            <span
                              className="whitespace-nowrap text-xs text-base-content/70"
                              title={t("submissions.table.gradedAtTitle")}
                            >
                              {t("submissions.table.gradedAt", {
                                date: formatDateTime(rest.gradedAt),
                              })}
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <div className="flex items-center gap-1">
                          {isGroup && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm btn-square text-base-content/70"
                              onClick={() => setManageOwner(rest.owner)}
                              aria-label={t("submissions.table.membersAria")}
                              title={t("submissions.table.members")}
                            >
                              <UsersRound
                                aria-hidden="true"
                                className="size-4"
                              />
                            </button>
                          )}
                          <ActionIconLink
                            href={repoHref}
                            icon={GitHub}
                            label={t("submissions.table.openRepoLabel", {
                              repo,
                            })}
                            title={t("submissions.table.viewRepo")}
                            emptyLabel={t("submissions.table.openRepoLabel", {
                              repo,
                            })}
                            emptyTitle={t("submissions.table.viewRepo")}
                          />
                          <ActionIconLink
                            href={safeHttpUrl(rest.commit)}
                            icon={GitCommitHorizontal}
                            label={t("submissions.table.viewCommit")}
                            title={t("submissions.table.commit")}
                            emptyLabel={t("submissions.table.noCommit")}
                            emptyTitle={t("submissions.table.noCommit")}
                          />
                          <ReviewButton org={org} repo={repo} />
                          <ActionIconLink
                            href={safeHttpUrl(rest.release)}
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
                            owner={rest.owner}
                            displayName={
                              isGroup
                                ? undefined
                                : getName(rest.owner, students) || undefined
                            }
                          />
                        </div>
                      </td>
                    </tr>
                    {canExpand && isOpen && (
                      <tr>
                        <td colSpan={5} className="bg-base-200/40">
                          <SubmissionHistory
                            submissions={rest.submissions}
                            repoHref={repoHref}
                            isGroup={isGroup}
                            students={students}
                            thresholdFraction={passBar}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              },
            )}
            {nonSubmitters.map((student) => (
              <tr
                key={`missing-${student.username || student.email || student.github_id}`}
                className="opacity-60"
              >
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
                      student.username
                        ? () => setProfileUsername(student.username)
                        : undefined
                    }
                  />
                </td>
                <td>
                  <span className="badge badge-ghost whitespace-nowrap">
                    {t("submissions.table.notSubmitted")}
                  </span>
                </td>
                <td>—</td>
                <td>—</td>
                <td>—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </EnterDiv>

      {isGroup && manageOwner && (
        <GroupCollaboratorsModal
          key={manageOwner}
          open
          onClose={() => setManageOwner(null)}
          org={org}
          repoName={studentRepoName(classroom, assignment, manageOwner)}
          repoUrl={studentRepoUrl(org, classroom, assignment, manageOwner)}
          ownerLogin={manageOwner}
          assignmentName={assignmentName}
          maxGroupSize={maxGroupSize}
          students={students}
        />
      )}

      {profileStudent && (
        <StudentProfileModal
          key={profileUsername}
          onClose={() => setProfileUsername(null)}
          student={profileStudent}
          students={students}
          repoName={
            profileHasRepo
              ? studentRepoName(classroom, assignment, profileStudent.username)
              : undefined
          }
          repoUrl={
            profileHasRepo
              ? studentRepoUrl(
                  org,
                  classroom,
                  assignment,
                  profileStudent.username,
                )
              : undefined
          }
        />
      )}
    </>
  )
}

export default SubmissionsTable
