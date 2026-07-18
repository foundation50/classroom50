import { Link, useParams } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import {
  ExternalLink,
  UserRound,
  UsersRound,
  CalendarClock,
} from "lucide-react"

import Breadcrumb from "@/components/breadcrumb"
import PageHeader from "@/components/PageHeader"
import PageShell from "@/components/PageShell"
import MissingParams from "@/components/MissingParams"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { useGithubAuth } from "@/auth/useGithubAuth"
import useGetSubmissionReleases from "@/hooks/useGetSubmissionReleases"
import useGetPublicAssignment from "@/hooks/useGetPublicAssignment"
import useGetAssignmentRepo from "@/hooks/useGetAssignmentRepo"
import useGetClassroom from "@/hooks/useGetClassroom"
import useDotClassroom50 from "@/hooks/useDotClassroom50"
import { studentRepoName } from "@/util/studentRepo"
import { formatDueDateTime, isPastDue } from "@/util/formatDate"
import { safeHttpUrl } from "@/util/url"
import type { GitHubRelease } from "@/github-core/types"
import type { Assignment } from "@/types/classroom"
import { assignmentDescription } from "@/types/classroom"
import { EnterDiv } from "@/lib/motionComponents"
import { Alert, Badge, Button, Card, Markdown } from "@/components/ui"
import SubmitGuidance from "@/components/SubmitGuidance"

// Strips the `submit/` tag prefix for a friendlier label, falling back to the
// release name when present.
const releaseLabel = (release: GitHubRelease): string =>
  release.name?.trim() || release.tag_name.replace(/^submit\//, "")

const ReleaseRow = ({ release }: { release: GitHubRelease }) => {
  const { t } = useTranslation()
  // html_url is from the GitHub API (always http(s)); guard anyway to keep the
  // no-unsafe-href rule uniform across views.
  const href = safeHttpUrl(release.html_url)
  const when = release.published_at ?? release.created_at

  return (
    <li className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate font-medium">{releaseLabel(release)}</p>
        <p className="text-sm text-base-content/70">
          {t("submissions.student.submittedAt", {
            date: formatDueDateTime(when),
          })}
        </p>
      </div>
      {href ? (
        <Button
          as="a"
          variant="outline"
          size="sm"
          href={href}
          target="_blank"
          rel="noreferrer"
          className="shrink-0"
        >
          {t("submissions.student.viewGrade")}
        </Button>
      ) : (
        <span className="text-sm text-base-content/70">
          {t("submissions.student.unavailable")}
        </span>
      )}
    </li>
  )
}

const AssignmentMeta = ({ assignment }: { assignment?: Assignment }) => {
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
}: {
  org: string
  classroom: string
  assignment: string
  // Capability-URL secret for a protected classroom; threads into the accept
  // link. Undefined for unprotected.
  secret?: string
}) => {
  const { t } = useTranslation()
  const { user } = useGithubAuth()
  const {
    data: releases,
    isLoading,
    isError,
    error,
  } = useGetSubmissionReleases(org, classroom, assignment, user?.login)
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

  if (isLoading || repoLoading) {
    return (
      <div className="mt-8 space-y-4">
        <div className="skeleton skeleton-shimmer h-24 w-full rounded-box" />
        <div className="skeleton skeleton-shimmer h-64 w-full rounded-box" />
      </div>
    )
  }

  if (isError || repoIsError) {
    const message =
      error instanceof Error
        ? error.message
        : repoError instanceof Error
          ? repoError.message
          : ""
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
          {t("submissions.student.notAccepted_prefix")}{" "}
          <Link
            className="underline"
            to="/$org/$classroom/assignments/$assignment/accept"
            params={{ org, classroom, assignment }}
            search={secret ? { k: secret } : undefined}
          >
            {t("submissions.student.notAccepted_link")}
          </Link>{" "}
          {t("submissions.student.notAccepted_suffix")}
        </div>
      </EnterDiv>
    )
  }

  if (!releases || releases.length === 0) {
    return (
      <EnterDiv className="mt-6 space-y-4">
        <Alert tone="info">
          <div>{t("submissions.student.noGradedYet")}</div>
        </Alert>
        <Button
          as="a"
          variant="outline"
          size="sm"
          href={studentRepo.html_url}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink aria-hidden="true" className="size-4" />
          {t("submissions.student.openMyRepo")}
        </Button>
        <SubmitGuidance repoHtmlUrl={studentRepo.html_url} />
      </EnterDiv>
    )
  }

  return (
    <div className="mt-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-base-content/70">
          {t("submissions.student.releasesIntro")}
        </p>
        <Button
          as="a"
          variant="outline"
          size="sm"
          href={studentRepo.html_url}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink aria-hidden="true" className="size-4" />
          {t("submissions.student.openMyRepo")}
        </Button>
      </div>

      <Card as={EnterDiv} bordered={false} className="border border-base-200">
        <ul className="divide-y divide-base-200">
          {releases.map((release) => (
            <ReleaseRow key={release.id} release={release} />
          ))}
        </ul>
      </Card>
    </div>
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

  const { assignment: assignmentData } = useGetPublicAssignment(
    org,
    classroom,
    assignment,
    secret,
  )

  const description = assignmentDescription(assignmentData)

  return (
    <PageShell selected="assignments">
      <Breadcrumb endpoint={t("nav.mySubmission")} />
      <PageHeader
        title={
          assignmentData?.name ||
          assignment ||
          t("submissions.student.fallbackTitle")
        }
      />
      <AssignmentMeta assignment={assignmentData} />
      {description ? (
        <div className="mt-3 flex flex-col gap-1">
          <span className="text-sm font-medium text-base-content/70">
            {t("submissions.student.descriptionLabel")}
          </span>
          <Markdown content={description} />
        </div>
      ) : null}
      {org && classroom && assignment ? (
        <SubmissionBody
          org={org}
          classroom={classroom}
          assignment={assignment}
          secret={secret}
        />
      ) : (
        <MissingParams message={t("submissions.student.missingParams")} />
      )}
    </PageShell>
  )
}

export default StudentSubmissionPage
