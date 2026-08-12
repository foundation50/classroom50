import { Link, useParams } from "@tanstack/react-router"
import { Trans, useTranslation } from "react-i18next"
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
import useGetMyTaggedSubmissions from "@/hooks/useGetMyTaggedSubmissions"
import useGetPublicAssignment from "@/hooks/useGetPublicAssignment"
import useGetAssignmentRepo from "@/hooks/useGetAssignmentRepo"
import useGetClassroom from "@/hooks/useGetClassroom"
import useDotClassroom50 from "@/hooks/useDotClassroom50"
import { studentRepoName } from "@/util/studentRepo"
import { repoTreeAtRefUrl } from "@/util/orgUrl"
import { formatDueDateTime, isPastDue } from "@/util/formatDate"
import { safeHttpUrl } from "@/util/url"
import type { GitHubRelease } from "@/github-core/types"
import type { DetectedSubmission } from "@/domain/assignments/submissionDetection"
import {
  detectedTagLabel,
  detectedTagRef,
  jumpableTagEntries,
} from "@/domain/assignments/submissionDetection"
import type { Assignment, SubmissionMode } from "@/types/classroom"
import { assignmentDescription } from "@/types/classroom"
import { EnterDiv } from "@/lib/motionComponents"
import { Alert, Badge, Button, Card, Markdown } from "@/components/ui"
import SubmitGuidance from "@/components/SubmitGuidance"
import { Tag } from "lucide-react"

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
        <Tag aria-hidden="true" className="size-3.5" />
        {submissionMode === "tag"
          ? t("submissions.student.modeTag")
          : t("submissions.student.modeEveryPush")}
      </Badge>
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

// The student's tagged submissions (tag mode only): one jump-to-tree link per
// detected tag or tag group. Branch-mode `commit` entries carry no tag and are
// excluded, so the card renders only tag/tag-group entries; when none exist it
// shows the empty hint so the student knows to push a tag.
const TaggedSubmissionsCard = ({
  entries,
  org,
  repo,
}: {
  entries: DetectedSubmission[]
  org: string
  repo: string
}) => {
  const { t } = useTranslation()
  const tagEntries = jumpableTagEntries(entries)

  return (
    <div className="space-y-2">
      <p className="text-sm text-base-content/70">
        {t("submissions.student.taggedIntro")}
      </p>
      {tagEntries.length === 0 ? (
        <Alert tone="info">
          <div>{t("submissions.student.taggedEmpty")}</div>
        </Alert>
      ) : (
        <Card as={EnterDiv} bordered={false} className="border border-base-200">
          <ul className="divide-y divide-base-200">
            {tagEntries.map((entry) => {
              const isGroup = entry.kind === "tag-group"
              const ref = detectedTagRef(entry)
              const href = ref ? repoTreeAtRefUrl(org, repo, ref) : undefined
              const label = isGroup
                ? t("submissions.student.tagGroupCount", {
                    pattern: entry.label,
                    count: entry.count,
                  })
                : detectedTagLabel(entry.label)
              return (
                <li
                  key={`${entry.kind}-${entry.label}`}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Tag
                      aria-hidden="true"
                      className="size-4 shrink-0 text-base-content/70"
                    />
                    <span className="truncate font-medium">{label}</span>
                  </span>
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
                      <ExternalLink aria-hidden="true" className="size-4" />
                      {t("submissions.student.jumpToTag")}
                    </Button>
                  ) : (
                    <span className="text-sm text-base-content/70">
                      {t("submissions.student.unavailable")}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </Card>
      )}
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
  // The assignment's submission definition. Tag mode surfaces the student's
  // tagged submissions with jump-to-tag links and tag-workflow guidance;
  // absent/every-push keeps the release-centric view.
  submissionMode?: SubmissionMode
  submissionTags?: string[]
}) => {
  const { t } = useTranslation()
  const { user } = useGithubAuth()
  const isTagMode = submissionMode === "tag"
  const {
    data: releases,
    isLoading,
    isError,
    error,
  } = useGetSubmissionReleases(org, classroom, assignment, user?.login)
  // Tagged submissions (tag mode only): read the student's own repo tags and
  // derive the detected tag/tag-group entries. The query is disabled outside
  // tag mode, so every-push assignments cost no extra read.
  const { data: taggedSubmissions } = useGetMyTaggedSubmissions(
    isTagMode ? org : undefined,
    isTagMode ? classroom : undefined,
    isTagMode ? assignment : undefined,
    isTagMode ? user?.login : undefined,
    submissionTags,
  )
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

  if (!releases || releases.length === 0) {
    return (
      <EnterDiv className="mt-6 space-y-4">
        <Alert tone="info">
          <div>{t("submissions.student.noGradedYet")}</div>
        </Alert>
        {/* Upload submission intentionally hidden — it does a destructive
            replace-all of the student's repo and has no per-assignment or
            classroom opt-out yet. See
            https://github.com/foundation50/classroom50/issues/428 */}
        <div className="flex flex-wrap items-center gap-2">
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
        {isTagMode ? (
          <TaggedSubmissionsCard
            entries={taggedSubmissions ?? []}
            org={org}
            repo={repoName}
          />
        ) : null}
        <SubmitGuidance
          repoHtmlUrl={studentRepo.html_url}
          submissionMode={submissionMode}
          submissionTags={submissionTags}
        />
      </EnterDiv>
    )
  }

  return (
    <div className="mt-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-base-content/70">
          {t("submissions.student.releasesIntro")}
        </p>
        {/* Upload submission intentionally hidden — see issue #428
            (https://github.com/foundation50/classroom50/issues/428). */}
        <div className="flex flex-wrap items-center gap-2">
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
      </div>

      {isTagMode ? (
        <TaggedSubmissionsCard
          entries={taggedSubmissions ?? []}
          org={org}
          repo={repoName}
        />
      ) : null}

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
        assignmentData?.locked ? (
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
