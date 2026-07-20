import {
  ChevronRight,
  GitCommitHorizontal,
  Inbox,
  MessageCircle,
  RefreshCw,
  ScrollText,
  SearchX,
} from "lucide-react"
import { Fragment, useId, useRef, useState } from "react"
import { Trans, useTranslation } from "react-i18next"

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
import {
  Badge,
  Button,
  EmphasisLtr,
  Modal,
  MonoLtr,
  rtlFlip,
} from "@/components/ui"
import { scoreTone } from "@/pages/submissions/dashboard"
import type { GroupRepo } from "@/pages/submissions/dashboard"
import {
  ActionIconLink,
  GroupActionControls,
  GroupMembers,
  GroupRepoRow,
  NonSubmitterRow,
  identitySubtitle,
} from "@/pages/submissions/SubmissionsRows"
import { ConfirmModal } from "@/components/modals"
import { GroupCollaboratorsModal } from "@/components/modals/GroupCollaboratorsModal"
import { StudentProfileModal } from "@/components/modals/StudentProfileModal"
import type { SubmissionAttempt, SubmissionRow } from "@/hooks/useGetScores"
import useGetFeedbackPr from "@/hooks/useGetFeedbackPr"
import useTriggerRegrade from "@/hooks/useTriggerRegrade"
import type { Student } from "@/types/classroom"
import { EnterDiv } from "@/lib/motionComponents"

const formatDateTime = (datetime: string) =>
  new Date(datetime).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })

// Score chip via the shared scoreTone recipe (one mapping for table + history):
// success/error tone for graded rows, neutral ghost for ungraded.
const ScoreBadge = ({
  score,
  max,
  thresholdFraction,
  size,
}: {
  score: number
  max: number
  thresholdFraction: number | null
  size?: "xs" | "sm" | "md"
}) => {
  const t = scoreTone(score, max, thresholdFraction)
  return (
    <Badge
      size={size}
      ghost={"ghost" in t && t.ghost}
      tone={"tone" in t ? t.tone : "neutral"}
    >
      {score}/{max}
    </Badge>
  )
}

type IconComponent = React.ComponentType<{ className?: string }>

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
      <Button
        variant="ghost"
        size="sm"
        shape="square"
        className="text-base-content/70 disabled:opacity-60"
        disabled={resolving}
        loading={resolving}
        loadingLabel={t("submissions.table.review")}
        onClick={handleReview}
        aria-label={t("submissions.table.reviewAria")}
        title={t("submissions.table.review")}
      >
        {!resolving && <MessageCircle aria-hidden="true" className="size-4" />}
      </Button>
      <Modal
        dialogRef={dialogRef}
        size="md"
        hideCloseButton
        aria-labelledby={titleId}
      >
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
              <Trans
                i18nKey="submissions.reviewModal.emptyBody"
                values={{ repo }}
                components={{ repo: <MonoLtr /> }}
              />
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
          <Button size="sm" onClick={() => dialogRef.current?.close()}>
            {t("common.close")}
          </Button>
        </div>
      </Modal>
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
      <Button
        variant="ghost"
        size="sm"
        shape="square"
        className="text-base-content/70 disabled:opacity-60"
        disabled={inFlight || blocked}
        loading={inFlight}
        loadingLabel={t("submissions.rowRegrade.title")}
        onClick={handleClick}
        aria-label={t("submissions.rowRegrade.aria", { owner })}
        title={title}
      >
        {!inFlight && (
          <RefreshCw
            aria-hidden="true"
            className={`size-4 ${phase === "completed" ? "text-success" : phase === "failed" ? "text-error" : ""}`}
          />
        )}
      </Button>
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
          <ScoreBadge
            score={s.score}
            max={s["max-score"]}
            thresholdFraction={thresholdFraction}
            size="sm"
          />
          {s.late ? (
            <Badge tone="error" title={t("submissions.table.lateHistoryTitle")}>
              {t("submissions.table.late")}
            </Badge>
          ) : null}
          {isGroup && s.submittedBy ? (
            <span className="text-base-content/70">
              {t("submissions.table.submittedBy", {
                name: getName(s.submittedBy, students) || s.submittedBy,
              })}
            </span>
          ) : null}
          <span className="ms-auto flex gap-3">
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
        <Trans
          i18nKey="submissions.table.fullHistory"
          components={{
            repoLink: (
              // eslint-disable-next-line jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label -- <Trans> injects the translated link text
              <a
                className="link"
                href={repoHref}
                target="_blank"
                rel="noreferrer"
              />
            ),
          }}
        />
      </li>
    </ol>
  )
}

const SubmissionsTable = ({
  scores,
  students,
  nonSubmitters = [],
  unsubmittedGroupRepos = [],
  isGroup = false,
  org,
  classroom,
  assignment,
  assignmentName,
  maxGroupSize,
  acceptedUsernames,
  thresholdFraction,
  filtered = false,
  onClearFilters,
  emptyRepo = false,
}: {
  scores: SubmissionRow[]
  students: Student[]
  nonSubmitters?: Student[]
  // Group repos that exist but have no submission yet (group assignments only).
  // Rendered as extra rows so teachers see teams that formed before any push.
  unsubmittedGroupRepos?: GroupRepo[]
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
  // Whether a search/filter is currently narrowing the set. Distinguishes the
  // empty state's "filters hide everything" case (offer Clear) from "nothing
  // collected yet" (guide to Collect now) — the table only receives already
  // filtered rows, so it can't infer this itself.
  filtered?: boolean
  // Clears the active search + filters (wired to the controls' clearAll).
  onClearFilters?: () => void
  // empty_repo assignment: never autogrades, so score badges and the
  // Feedback-PR/regrade actions are hidden (repos + accept state stay useful).
  emptyRepo?: boolean
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
            {!scores?.length &&
              !nonSubmitters.length &&
              !unsubmittedGroupRepos.length && (
                <tr>
                  <td colSpan={5} className="py-10 text-center">
                    <div className="mx-auto flex max-w-sm flex-col items-center gap-2">
                      {filtered ? (
                        <>
                          <SearchX
                            aria-hidden="true"
                            className="size-8 text-base-content/40"
                          />
                          <p className="font-medium">
                            {t("submissions.table.emptyFilteredTitle")}
                          </p>
                          <p className="text-sm text-base-content/70">
                            {t("submissions.table.emptyFilteredBody")}
                          </p>
                          {onClearFilters && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="mt-1"
                              onClick={onClearFilters}
                            >
                              {t("submissions.table.emptyClearFilters")}
                            </Button>
                          )}
                        </>
                      ) : (
                        <>
                          <Inbox
                            aria-hidden="true"
                            className="size-8 text-base-content/40"
                          />
                          <p className="font-medium">
                            {t("submissions.table.emptyNoDataTitle")}
                          </p>
                          <p className="text-sm text-base-content/70">
                            {t("submissions.table.emptyNoDataBody")}
                          </p>
                        </>
                      )}
                    </div>
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
                              className={`size-3.5 transition-transform ${rtlFlip} ${isOpen ? "rotate-90" : ""}`}
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
                        {emptyRepo ? (
                          <span
                            className="text-base-content/50"
                            title={t("submissions.table.noGradingTitle")}
                          >
                            —
                          </span>
                        ) : (
                          <ScoreBadge
                            score={score}
                            max={rest["max-score"]}
                            thresholdFraction={passBar}
                          />
                        )}
                      </td>
                      <td>
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className="whitespace-nowrap">
                              {formatDateTime(datetime)}
                            </span>
                            {late ? (
                              <Badge
                                tone="error"
                                title={t("submissions.table.lateRowTitle")}
                              >
                                {t("submissions.table.late")}
                              </Badge>
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
                            <GroupActionControls
                              repo={repo}
                              repoHref={repoHref}
                              onManage={() => setManageOwner(rest.owner)}
                            />
                          )}
                          {!isGroup && (
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
                          )}
                          <ActionIconLink
                            href={safeHttpUrl(rest.commit)}
                            icon={GitCommitHorizontal}
                            label={t("submissions.table.viewCommit")}
                            title={t("submissions.table.commit")}
                            emptyLabel={t("submissions.table.noCommit")}
                            emptyTitle={t("submissions.table.noCommit")}
                          />
                          {!emptyRepo && (
                            <>
                              <ReviewButton org={org} repo={repo} />
                              <ActionIconLink
                                href={safeHttpUrl(rest.release)}
                                icon={ScrollText}
                                label={t("submissions.table.viewDetails")}
                                title={t("submissions.table.details")}
                                emptyLabel={t(
                                  "submissions.table.noDetailsLabel",
                                )}
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
                            </>
                          )}
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
              <NonSubmitterRow
                key={`missing-${student.username || student.email || student.github_id}`}
                student={student}
                students={students}
                isGroup={isGroup}
                acceptedUsernames={acceptedUsernames}
                org={org}
                classroom={classroom}
                assignment={assignment}
                onProfile={setProfileUsername}
              />
            ))}
            {unsubmittedGroupRepos.map(({ owner, repoName }) => (
              <GroupRepoRow
                key={`group-${repoName}`}
                org={org}
                classroom={classroom}
                assignment={assignment}
                owner={owner}
                repoName={repoName}
                students={students}
                onManage={() => setManageOwner(owner)}
              />
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
