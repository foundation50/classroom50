import { Link, useParams } from "@tanstack/react-router"
import { SkeletonRegion } from "@/components/list"
import { useRef, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { CalendarIcon, PeopleIcon, PersonIcon } from "@/components/ui/icons"

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
import {
  formatDueDateTime,
  formatRelativeToNow,
  isPastDue,
} from "@/util/formatDate"
import { safeHttpUrl } from "@/util/url"
import type { GitHubCommit, GitHubRelease } from "@/github-core/types"
import { SUBMISSION_TAG_PREFIX } from "@/github-core/queries/releaseRunReads"
import {
  submissionModeCountKey,
  latestDetectedAt,
} from "@/domain/assignments/submissionDetection"
import type { Assignment, SubmissionMode } from "@/types/classroom"
import { assignmentDescription } from "@/types/classroom"
import { EnterDiv } from "@/lib/motionComponents"
import { Alert, Badge, Button, Markdown, TableShell } from "@/components/ui"
import {
  SubmissionDetailsModal,
  detailItemsCount,
  type SubmissionDetailItem,
} from "@/components/submissions/SubmissionDetailsModal"
import {
  buildSubmissionDetailItems,
  submissionEmptyState,
  type PushSubmission,
} from "@/components/submissions/submissionDetailItems"
import {
  LastSubmittedCell,
  MetaItem,
  MetaStrip,
  SubmissionCountCell,
} from "@/components/submissions/SubmissionRowCells"
import { StudentRowActions } from "@/pages/submissions/StudentRowActions"
import SubmitGuidance from "@/components/SubmitGuidance"

// A submit/<UTC-ts>-<short-sha> release tag → its trailing short sha, so a
// push submission can link the graded release published at its commit. Returns
// undefined for a milestone or malformed tag (no reliable per-commit release).
const releaseShaFromTag = (tagName: string): string | undefined => {
  if (!tagName.startsWith(SUBMISSION_TAG_PREFIX)) return undefined
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
    datetime: commit.commit.committer?.date ?? commit.commit.author?.date,
    releaseHref: releaseHrefBySha.get(commit.sha.slice(0, 7)),
  }))
}

const AssignmentMeta = ({ assignment }: { assignment?: Assignment }) => {
  const { t } = useTranslation()
  if (!assignment) return null
  const due = assignment.due
  const overdue = due ? isPastDue(due) : false

  // Deliberately student-scoped: the submission-mode and autograding
  // indicators the teacher heading shows are plumbing from a student's
  // perspective — how to submit is the guidance box's job, and grading
  // internals aren't actionable for them. Only mode and deadline remain.
  return (
    <div>
      <MetaStrip
        items={[
          assignment.mode === "group" ? (
            <MetaItem>
              <PeopleIcon aria-hidden="true" className="size-4" />
              {t("submissions.student.modeGroup")}
            </MetaItem>
          ) : assignment.mode === "individual" ? (
            <MetaItem>
              <PersonIcon aria-hidden="true" className="size-4" />
              {t("submissions.student.modeIndividual")}
            </MetaItem>
          ) : null,
          // Overdue is a state, so it keeps the error badge; a normal or
          // absent due date is a quiet property like the rest of the strip.
          overdue ? (
            <Badge tone="error" className="gap-1">
              <CalendarIcon aria-hidden="true" className="size-4" />
              {due
                ? t("submissions.dueDate", { date: formatDueDateTime(due) })
                : t("submissions.noDueDate")}
            </Badge>
          ) : (
            <MetaItem title={due ? formatDueDateTime(due) : undefined}>
              <CalendarIcon aria-hidden="true" className="size-4" />
              {due
                ? t("submissions.dueDate", { date: formatDueDateTime(due) })
                : t("submissions.noDueDate")}
            </MetaItem>
          ),
        ]}
      />
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
    submissionListLoading,
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

  // Guidance expansion: open while nothing is submitted (the student needs the
  // how-to), collapsed once work is in — but always re-openable, both from the
  // <details> summary and the status callout's CTA. `null` = the student
  // hasn't toggled it, so the submission count decides.
  const [guideToggled, setGuideToggled] = useState<boolean | null>(null)
  const guideRef = useRef<HTMLDetailsElement>(null)

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
  // The guide's effective expansion: the student's explicit toggle wins, else
  // open only while nothing is submitted.
  const guideOpen = guideToggled ?? submissionCount === 0

  // The newest submission's time for the "last submitted" cell: the newest
  // push's commit date in every-push mode; in tag mode the newest detected
  // tag's time (a canonical submit/* name encodes it) — the actual submission
  // instant — falling back to the newest graded release's publish time for a
  // dateless milestone tag. Absent until the first submission lands.
  const latestSubmittedAt = isTagMode
    ? (latestDetectedAt(taggedSubmissions) ??
      releases?.[0]?.published_at ??
      releases?.[0]?.created_at ??
      undefined)
    : (pushSubmissions?.[0]?.commit.committer?.date ??
      pushSubmissions?.[0]?.commit.author?.date)

  // Render once, settled: gate on every read that shapes the body (repo
  // existence, graded releases, AND the active-mode submission list) so the
  // page never first paints "0 submissions / guide expanded" and then flips
  // when the list lands a beat later.
  if (releasesLoading || repoLoading || submissionListLoading) {
    return (
      <SkeletonRegion className="space-y-4">
        <div className="skeleton skeleton-shimmer h-24 w-full rounded-box" />
        <div className="skeleton skeleton-shimmer h-40 w-full rounded-box" />
      </SkeletonRegion>
    )
  }

  if (releasesError || repoIsError || submissionListError) {
    const firstError = [releasesErrorObj, repoError].find(
      (e) => e instanceof Error,
    )
    const message = firstError instanceof Error ? firstError.message : ""
    return (
      <Alert tone="error">
        {t("submissions.student.loadError")}
        {message ? ` ${message}` : ""}
      </Alert>
    )
  }

  // No repo means the student hasn't accepted yet.
  if (!studentRepo) {
    return (
      <EnterDiv>
        <Alert tone="info">
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
        </Alert>
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
    <EnterDiv className="space-y-4">
      {/* The page's headline answer: is my work in? Success once anything is
          submitted; otherwise an info nudge pointing into the how-to guide. */}
      {submissionCount > 0 ? (
        <Alert tone="success" role="status">
          <span>
            {latestSubmittedAt
              ? t("submissions.student.statusSubmitted", {
                  relative: formatRelativeToNow(new Date(latestSubmittedAt)),
                })
              : t("submissions.student.submittedAwaitingGrading")}
          </span>
        </Alert>
      ) : (
        <Alert tone="info" role="status">
          <span>{t("submissions.student.statusNotSubmitted")}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setGuideToggled(true)
              guideRef.current?.scrollIntoView({ block: "nearest" })
            }}
          >
            {t("submissions.student.statusNotSubmittedCta")}
          </Button>
        </Alert>
      )}
      {/* One-row, teacher-style submissions table for the student's own repo.
          The count chip opens the shared details modal (tags or pushes); the
          student column set omits the teacher-only score and management
          actions. The shell's own entrance is off — the surrounding EnterDiv
          already animates this block. */}
      <TableShell animate={false}>
        <caption className="sr-only">
          {t("submissions.student.tableCaption")}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t("submissions.student.colYourRepo")}</th>
            <th scope="col">{t("submissions.table.colSubmissions")}</th>
            <th scope="col">{t("submissions.table.colLastSubmitted")}</th>
            <th scope="col">
              <span className="sr-only">
                {t("submissions.table.colActions")}
              </span>
            </th>
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
                    className="link link-hover block max-w-72 truncate font-mono text-xs"
                    href={repoHref}
                    target="_blank"
                    rel="noreferrer"
                    title={repoName}
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
                <div className="flex flex-wrap items-center gap-x-2">
                  <LastSubmittedCell datetime={latestSubmittedAt} />
                  {/* Relative time answers "did my push just register?"
                        without date math. */}
                  <span className="whitespace-nowrap text-base-content/60">
                    {formatRelativeToNow(new Date(latestSubmittedAt))}
                  </span>
                </div>
              ) : submissionCount > 0 ? (
                // Submissions exist (e.g. a pushed milestone tag) but none
                // has a graded release yet, so there's no timestamp to show.
                // "Not submitted yet" beside a positive count would
                // contradict itself — say the work is in and awaiting
                // grading instead.
                <span className="text-base-content/60">
                  {t("submissions.student.submittedAwaitingGrading")}
                </span>
              ) : (
                <span className="text-base-content/60">
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
      </TableShell>

      <SubmitGuidance
        ref={guideRef}
        open={guideOpen}
        // Chrome fires `toggle` when a <details open> is inserted (and when we
        // change `open` programmatically), so only a toggle that DIFFERS from
        // the rendered state is a real user choice — otherwise the initial
        // auto-open would latch as intent and the guide would never collapse
        // after the first submission lands.
        onToggle={(open) => {
          if (open !== guideOpen) setGuideToggled(open)
        }}
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
  const {
    assignment: assignmentData,
    isLoading: assignmentLoading,
    isError: assignmentError,
  } = useSubmissionAssignment(org, classroom, assignment, {
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
        loading={assignmentLoading}
        title={
          assignmentData?.name ||
          assignment ||
          t("submissions.student.fallbackTitle")
        }
        subtitle={<AssignmentMeta assignment={assignmentData} />}
      />
      {description ? (
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-base-content/70">
            {t("submissions.student.descriptionLabel")}
          </span>
          <Markdown content={description} />
        </div>
      ) : null}
      {org && classroom && assignment ? (
        assignmentLoading ? (
          // Hold the body on the same skeleton the submission reads use until
          // the assignment metadata (mode, tags, locked) resolves — mounting
          // SubmissionBody with a default mode would fetch the wrong list and
          // flash the wrong guidance before flipping.
          <SkeletonRegion className="space-y-4">
            <div className="skeleton skeleton-shimmer h-24 w-full rounded-box" />
            <div className="skeleton skeleton-shimmer h-40 w-full rounded-box" />
          </SkeletonRegion>
        ) : assignmentError ? (
          // A failed Pages metadata read must surface, not silently degrade to
          // the raw slug title + default (push) mode — which would render the
          // wrong guidance for a tag-mode assignment. SubmissionBody would show
          // its own error for the submission reads, but the mode/title come from
          // here, so guard this read too.
          <Alert tone="error">{t("submissions.student.loadError")}</Alert>
        ) : assignmentData?.locked ? (
          <EnterDiv>
            <Alert tone="warning">
              <div>{t("submissions.student.locked")}</div>
            </Alert>
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
