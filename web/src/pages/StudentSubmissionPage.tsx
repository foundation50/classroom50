import { Link, useParams } from "@tanstack/react-router"
import { useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { UserRound, UsersRound, CalendarClock } from "lucide-react"

import Breadcrumb from "@/components/breadcrumb"
import PageHeader from "@/components/PageHeader"
import PageShell from "@/components/PageShell"
import MissingParams from "@/components/MissingParams"
import Avatar from "@/components/avatar"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { useGithubAuth } from "@/auth/useGithubAuth"
import useMySubmissions from "@/hooks/useMySubmissions"
import { useSubmissionAssignment } from "@/hooks/useSubmissionAssignment"
import useGetAssignmentRepo from "@/hooks/useGetAssignmentRepo"
import useGetClassroom from "@/hooks/useGetClassroom"
import useDotClassroom50 from "@/hooks/useDotClassroom50"
import { studentRepoName } from "@/util/studentRepo"
import { formatDueDateTime, isPastDue } from "@/util/formatDate"
import { safeHttpUrl } from "@/util/url"
import type { GitHubCommit, GitHubRelease } from "@/github-core/types"
import {
  submissionModeBadgeKey,
  submissionModeCountKey,
} from "@/domain/assignments/submissionDetection"
import { assignmentSkipsGrading } from "@/domain/assignments/autogradingState"
import type { Assignment, SubmissionMode } from "@/types/classroom"
import { assignmentDescription } from "@/types/classroom"
import { EnterDiv } from "@/lib/motionComponents"
import { Alert, Badge, Markdown } from "@/components/ui"
import {
  SubmissionDetailsModal,
  detailItemsCount,
  type SubmissionDetailItem,
} from "@/components/submissions/SubmissionDetailsModal"
import { AssignmentSetupBadge } from "@/components/submissions/AssignmentSetupBadge"
import {
  buildSubmissionDetailItems,
  submissionEmptyState,
  type PushSubmission,
} from "@/components/submissions/submissionDetailItems"
import {
  LastSubmittedCell,
  SubmissionCountCell,
  SubmissionModeIcon,
} from "@/components/submissions/SubmissionRowCells"
import { StudentRowActions } from "@/pages/submissions/StudentRowActions"
import SubmitGuidance from "@/components/SubmitGuidance"

// A submit/<UTC-ts>-<short-sha> release tag → its trailing short sha, so a
// push submission can link the graded release published at its commit. Returns
// undefined for a milestone or malformed tag (no reliable per-commit release).
const releaseShaFromTag = (tagName: string): string | undefined => {
  if (!tagName.startsWith("submit/")) return undefined
  const sha = tagName.slice(tagName.lastIndexOf("-") + 1)
  return sha || undefined
}

// short sha → graded release URL, built from the student's submit/* releases.
// Push submissions match their commit into this to fold in a "View grade" link.
const releaseHrefByShaFrom = (
  releases: GitHubRelease[] | undefined,
): Map<string, string> => {
  const map = new Map<string, string>()
  for (const release of releases ?? []) {
    const sha = releaseShaFromTag(release.tag_name)
    const href = safeHttpUrl(release.html_url)
    if (sha && href) map.set(sha, href)
  }
  return map
}

// Map the student's default-branch commits to push submissions, folding in a
// per-commit "View grade" link where a graded release matches the commit sha.
// Wraps the tag-parse + release-map so the component body stays declarative.
const toPushSubmissions = (
  commits: GitHubCommit[] | undefined,
  releases: GitHubRelease[] | undefined,
): PushSubmission[] => {
  const releaseHrefBySha = releaseHrefByShaFrom(releases)
  return (commits ?? []).map((commit, i) => ({
    key: `${commit.sha}-${i}`,
    commitHref: commit.html_url,
    datetime: commit.commit.author?.date,
    releaseHref: releaseHrefBySha.get(commit.sha.slice(0, 7)),
  }))
}

const AssignmentMeta = ({
  assignment,
  submissionMode,
}: {
  assignment?: Assignment
  submissionMode?: SubmissionMode
}) => {
  const { t } = useTranslation()
  if (!assignment) return null
  const due = assignment.due
  const overdue = due ? isPastDue(due) : false

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {assignment.mode === "group" ? (
        <Badge ghost className="gap-1">
          <UsersRound aria-hidden="true" className="size-3.5" />{" "}
          {t("submissions.student.modeGroup")}
        </Badge>
      ) : assignment.mode === "individual" ? (
        <Badge ghost className="gap-1">
          <UserRound aria-hidden="true" className="size-3.5" />{" "}
          {t("submissions.student.modeIndividual")}
        </Badge>
      ) : null}
      <Badge ghost className="gap-1">
        <SubmissionModeIcon mode={submissionMode} />
        {t(
          submissionModeBadgeKey(
            submissionMode,
            assignmentSkipsGrading(assignment),
          ),
        )}
      </Badge>
      <AssignmentSetupBadge assignment={assignment} size="sm" />
      <Badge
        tone={overdue ? "error" : "neutral"}
        ghost={!overdue}
        className="gap-1"
      >
        <CalendarClock aria-hidden="true" className="size-3.5" />
        {due
          ? t("submissions.dueDate", { date: formatDueDateTime(due) })
          : t("submissions.noDueDate")}
      </Badge>
    </div>
  )
}

const SubmissionBody = ({
  org,
  classroom,
  assignment,
  secret,
  submissionMode,
  submissionTags,
}: {
  org: string
  classroom: string
  assignment: string
  // Capability-URL secret for a protected classroom; threads into the accept
  // link. Undefined for unprotected.
  secret?: string
  submissionMode?: SubmissionMode
  submissionTags?: string[]
}) => {
  const { t } = useTranslation()
  const { user } = useGithubAuth()
  const isTagMode = submissionMode === "tag"
  const {
    releases,
    tags: taggedSubmissions,
    pushes: pushSubmissions,
    releasesLoading,
    releasesError,
    releasesErrorObj,
    submissionListError,
  } = useMySubmissions(org, classroom, assignment, user?.login, {
    mode: submissionMode,
    submissionTags,
  })
  // Distinguish "never accepted" (no repo) from "accepted but not yet graded".
  // getRepo returns null only on a true 404; a 403/5xx throws, so read the repo
  // query's error too — else a transient/permission failure falls through to
  // the "haven't accepted yet" CTA and misdirects the student.
  const {
    assignment: studentRepo,
    isLoading: repoLoading,
    isError: repoIsError,
    error: repoError,
  } = useGetAssignmentRepo(org, classroom, assignment, user?.login)

  const repoName = studentRepoName(classroom, assignment, user?.login ?? "")

  const [detailsOpen, setDetailsOpen] = useState(false)

  // Fold graded releases into the submission list: push submissions link the
  // release published at their commit; the newest release is offered as a
  // direct "autograder details" shortcut in the actions cell.
  const latestReleaseHref = safeHttpUrl(releases?.[0]?.html_url)
  const commitSubmissions = toPushSubmissions(pushSubmissions, releases)

  const detailItems: SubmissionDetailItem[] = buildSubmissionDetailItems(
    { tags: taggedSubmissions, commits: commitSubmissions },
    submissionMode,
    org,
    repoName,
    t,
  )
  // The number of SUBMISSIONS the listed items represent — a glob group's row
  // counts its N matches (detailItemsCount), so this stays consistent with the
  // teacher chip for the same tags rather than counting group rows.
  const submissionCount = detailItemsCount(detailItems)

  // The newest submission's time for the "last submitted" cell: the newest
  // push's commit date in every-push mode, else the newest graded release's
  // publish time (a tag submission's time isn't carried by detection). Absent
  // until the first submission lands.
  const latestSubmittedAt = isTagMode
    ? (releases?.[0]?.published_at ?? releases?.[0]?.created_at ?? undefined)
    : pushSubmissions?.[0]?.commit.author?.date

  if (releasesLoading || repoLoading) {
    return (
      <div className="mt-8 space-y-4">
        <div className="skeleton skeleton-shimmer h-24 w-full rounded-box" />
        <div className="skeleton skeleton-shimmer h-40 w-full rounded-box" />
      </div>
    )
  }

  if (releasesError || repoIsError || submissionListError) {
    const firstError = [releasesErrorObj, repoError].find(
      (e) => e instanceof Error,
    )
    const message = firstError instanceof Error ? firstError.message : ""
    return (
      <Alert tone="error" className="mt-6">
        {t("submissions.student.loadError")}
        {message ? ` ${message}` : ""}
      </Alert>
    )
  }

  // No repo means the student hasn't accepted yet.
  if (!studentRepo) {
    return (
      <EnterDiv className="alert alert-info alert-soft mt-6">
        <div>
          <Trans
            i18nKey="submissions.student.notAccepted"
            components={{
              acceptLink: (
                <Link
                  className="underline"
                  to="/$org/$classroom/assignments/$assignment/accept"
                  params={{ org, classroom, assignment }}
                  search={secret ? { k: secret } : undefined}
                />
              ),
            }}
          />
        </div>
      </EnterDiv>
    )
  }

  // Guard the repo URL from the GitHub API before rendering it as a link, so it
  // goes through the same safeHttpUrl check as every other href on this page
  // (the empty-state link already did). The API always returns an https
  // github.com URL, so this is a consistency guard; fall back to the raw value
  // for the components that require a definite string and derive their own URLs.
  const rawRepoHref = studentRepo.html_url
  const safeRepoHref = safeHttpUrl(rawRepoHref)
  const repoHref = safeRepoHref ?? rawRepoHref

  return (
    <EnterDiv className="mt-6 space-y-4">
      {/* One-row, teacher-style submissions table for the student's own repo.
          The count chip opens the shared details modal (tags or pushes); the
          student column set omits the teacher-only score and management
          actions. */}
      <div className="overflow-x-auto rounded-box border border-base-content/5 bg-base-100">
        <table className="table">
          <caption className="sr-only">
            {t("submissions.student.tableCaption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("submissions.table.colStudent")}</th>
              <th scope="col">{t("submissions.table.colSubmissions")}</th>
              <th scope="col">{t("submissions.table.colLastSubmitted")}</th>
              <th scope="col">{t("submissions.table.colActions")}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <Avatar
                  name={user?.name || user?.login || ""}
                  initials=""
                  github={user?.login || ""}
                  subtitle={
                    <a
                      className="link link-hover font-mono text-xs"
                      href={repoHref}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {repoName}
                    </a>
                  }
                />
              </td>
              <td>
                <SubmissionCountCell
                  mode={submissionMode}
                  count={submissionCount}
                  onOpen={() => setDetailsOpen(true)}
                />
              </td>
              <td>
                {latestSubmittedAt ? (
                  <LastSubmittedCell datetime={latestSubmittedAt} />
                ) : (
                  <span className="text-base-content/50">
                    {t("submissions.student.notSubmittedYet")}
                  </span>
                )}
              </td>
              <td>
                <StudentRowActions
                  repo={repoName}
                  repoHref={repoHref}
                  hasRepo
                  latestReleaseHref={latestReleaseHref}
                  onViewSubmissions={() => setDetailsOpen(true)}
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <SubmitGuidance
        repoHtmlUrl={repoHref}
        submissionMode={submissionMode}
        submissionTags={submissionTags}
      />

      {detailsOpen ? (
        <SubmissionDetailsModal
          onClose={() => setDetailsOpen(false)}
          title={t("submissions.student.detailsTitle")}
          repo={repoName}
          repoHref={repoHref}
          countLabel={t(submissionModeCountKey(submissionMode), {
            count: submissionCount,
          })}
          items={detailItems}
          {...submissionEmptyState(
            submissionMode,
            org,
            repoName,
            safeRepoHref,
            t,
          )}
        />
      ) : null}
    </EnterDiv>
  )
}

const StudentSubmissionPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.mySubmission"))
  const { org, classroom, assignment } = useParams({ strict: false })
  const { user } = useGithubAuth()
  // Resolve the capability-URL secret (protected classrooms) from two sources
  // in order: (1) the student's accepted repo's .classroom50.yaml — the only
  // source a real student can read; (2) the private classroom.json — staff-only
  // (incl. a teacher previewing as a student), so a not-yet-accepted
  // preview still gets a working link. Empty when unprotected.
  const repoName =
    classroom && assignment && user?.login
      ? studentRepoName(classroom, assignment, user.login)
      : ""
  const { secret: repoSecret } = useDotClassroom50(org ?? "", repoName)
  // classroom.json 404s for a real student (private) — fine, just yields no
  // secret; the repo secret covers the post-accept case.
  const { data: classroomMeta } = useGetClassroom(org, classroom)
  const secret = repoSecret || classroomMeta?.secret || undefined

  // Student page is student-gated by the route, so its assignment metadata comes
  // from PUBLIC GitHub Pages (source:"pages") — students can't read the private
  // config repo. The capability secret unlocks a protected classroom's Pages
  // path.
  const { assignment: assignmentData, isError: assignmentError } =
    useSubmissionAssignment(org, classroom, assignment, {
      source: "pages",
      secret,
    })

  const description = assignmentDescription(assignmentData)
  const submissionMode = assignmentData?.submission_mode
  const submissionTags = assignmentData?.submission_tags

  return (
    <PageShell>
      <Breadcrumb endpoint={t("nav.mySubmission")} />
      <PageHeader
        title={
          assignmentData?.name ||
          assignment ||
          t("submissions.student.fallbackTitle")
        }
      />
      <AssignmentMeta
        assignment={assignmentData}
        submissionMode={submissionMode}
      />
      {description ? (
        <div className="mt-3 flex flex-col gap-1">
          <span className="text-sm font-medium text-base-content/70">
            {t("submissions.student.descriptionLabel")}
          </span>
          <Markdown content={description} />
        </div>
      ) : null}
      {org && classroom && assignment ? (
        assignmentError ? (
          // A failed Pages metadata read must surface, not silently degrade to
          // the raw slug title + default (push) mode — which would render the
          // wrong guidance for a tag-mode assignment. SubmissionBody would show
          // its own error for the submission reads, but the mode/title come from
          // here, so guard this read too.
          <Alert tone="error" className="mt-6">
            {t("submissions.student.loadError")}
          </Alert>
        ) : assignmentData?.locked ? (
          <EnterDiv className="alert alert-warning alert-soft mt-6">
            <div>{t("submissions.student.locked")}</div>
          </EnterDiv>
        ) : (
          <SubmissionBody
            org={org}
            classroom={classroom}
            assignment={assignment}
            secret={secret}
            submissionMode={submissionMode}
            submissionTags={submissionTags}
          />
        )
      ) : (
        <MissingParams message={t("submissions.student.missingParams")} />
      )}
    </PageShell>
  )
}

export default StudentSubmissionPage
