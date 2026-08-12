import { Inbox, SearchX } from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  getName,
  getInitials,
  getSection,
  resolveStudent,
} from "@/util/students"
import { studentRepoName, studentRepoUrl } from "@/util/studentRepo"
import { repoCommitUrl } from "@/util/orgUrl"
import Avatar from "@/components/avatar"
import { Badge, Button, Spinner, TablePagination } from "@/components/ui"
import type { GroupRepo } from "@/pages/submissions/dashboard"
import type { SubmissionSort } from "@/pages/submissions/dashboard"
import {
  buildRosterDisplayItems,
  buildGroupDisplayItems,
  buildGroupRosterDisplayItems,
  buildSortedDisplayItems,
  hasAccepted,
  pageBounds,
  paginateDisplayItems,
  paginationRange,
  PAGE_SIZE_OPTIONS,
} from "@/pages/submissions/dashboard"
import {
  GroupActionControls,
  GroupMembers,
  GroupRepoRow,
  NonSubmitterRow,
  identitySubtitle,
} from "@/pages/submissions/SubmissionsRows"
import {
  IndividualRowHeader,
  RepoRowActions,
} from "@/pages/submissions/SubmissionsRowActions"
import { ManageSubmissionModal } from "@/pages/submissions/ManageSubmissionModal"
import { ScoreBadge as SharedScoreBadge } from "@/pages/submissions/ScoreBadge"
import { ManualGradeCell } from "@/pages/submissions/ManualGradeCell"
import type { ManualGradeContext } from "@/pages/submissions/ManualGradeCell"
import { GroupCollaboratorsModal } from "@/components/modals/GroupCollaboratorsModal"
import { RepoAccessModal } from "@/components/modals/RepoAccessModal"
import { StudentProfileModal } from "@/components/modals/StudentProfileModal"
import {
  SubmissionDetailsModal,
  detailItemsCount,
  type SubmissionDetailItem,
} from "@/components/submissions/SubmissionDetailsModal"
import {
  buildSubmissionDetailItems,
  submissionEmptyState,
  type PushSubmission,
  type CollectedTagSubmission,
} from "@/components/submissions/submissionDetailItems"
import {
  LastSubmittedCell,
  SubmissionCountCell,
} from "@/components/submissions/SubmissionRowCells"
import type { SubmissionRow } from "@/hooks/useGetScores"
import { submissionModeCountKey } from "@/domain/assignments/submissionDetection"
import type { Student, SubmissionMode } from "@/types/classroom"
import { EnterDiv } from "@/lib/motionComponents"

// Score chip: the shared ScoreBadge (one recipe, one source — see
// ./ScoreBadge). Imported rather than re-implemented so the manual-grade cell
// and this table can't drift.
const ScoreBadge = SharedScoreBadge

// The row context the submission hub (ManageSubmissionModal) renders from,
// captured when the row's Manage control is clicked. `title`/`subtitle` are the
// identity to show; the rest gate and target the per-action rows.
type ManageSubmissionContext = {
  owner: string
  isGroup: boolean
  title: string
  subtitle?: string
  repo: string
  repoHref: string
  hasRepo: boolean
  commit?: string | null
  release?: string | null
  displayName?: string
}

// The context the type-aware submission-details modal renders from, captured
// when a row's submission-count chip is clicked.
type SubmissionDetailsContext = {
  owner: string
  title: string
  subtitle?: string
  repo: string
  repoHref: string
  items: SubmissionDetailItem[]
}

// Build the type-aware detail items for a row via the shared builder: tag
// entries in tag mode, the default-branch pushes otherwise.
//
// Every-push commits come from the DETECTED entries (`row.detectedEntries`,
// kind "commit") — the same source the count chip is bumped from — so the modal
// lists exactly the pushes the chip counts, even before a collect ingests them.
// Each detected commit links its commit page and, when a collected attempt at
// that sha carries a graded release, folds in a "View grade" link. When there
// are no detected commits (e.g. a non-owner viewer, whose chip also uses the
// collected count), fall back to the collected `submissions`.
//
// Tag mode is symmetric: detected tag entries drive the list for an owner with
// the detection overlay; a viewer without it (a non-owner staff member, or the
// owner before detection resolves) falls back to the collected `submissions`
// so the modal never renders a false "no tagged submissions" empty state beside
// a positive count chip.
function buildDetailItems(
  row: SubmissionRow,
  mode: SubmissionMode,
  org: string,
  repo: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): SubmissionDetailItem[] {
  const detectedCommits = (row.detectedEntries ?? []).filter(
    (e) => e.kind === "commit",
  )
  // sha (short or full, whichever the collected commit URL ends with) -> the
  // graded release URL for that attempt, so a detected push can link its grade.
  const releaseByCommit = new Map<string, string>()
  for (const s of row.submissions) {
    const sha = s.commit?.split("/").pop()
    if (sha && s.release) releaseByCommit.set(sha, s.release)
  }

  const commits: PushSubmission[] =
    detectedCommits.length > 0
      ? detectedCommits.map((e) => ({
          key: `commit-${e.sha ?? e.label}`,
          commitHref: e.sha ? repoCommitUrl(org, repo, e.sha) : undefined,
          // Detection doesn't carry a per-commit time; the collected attempt
          // (when present) does, matched by sha below.
          datetime: undefined,
          releaseHref: e.sha
            ? (releaseByCommit.get(e.sha) ??
              releaseByCommit.get(e.sha.slice(0, 7)))
            : undefined,
        }))
      : row.submissions.map((s, i) => ({
          key: `${s.datetime}-${s.commit}-${i}`,
          commitHref: s.commit,
          datetime: s.datetime,
          releaseHref: s.release,
        }))

  // Tag-mode fallback for a viewer without the detection overlay: the collected
  // attempts, jumping to the graded release (else the commit).
  const collectedTags: CollectedTagSubmission[] = row.submissions.map(
    (s, i) => ({
      key: `tag-${s.datetime}-${s.commit}-${i}`,
      datetime: s.datetime,
      commitHref: s.commit,
      releaseHref: s.release,
    }),
  )

  return buildSubmissionDetailItems(
    { tags: row.detectedEntries ?? [], commits, collectedTags },
    mode,
    org,
    repo,
    t,
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
  submissionMode,
  submissionTags,
  assignmentMode = "every-push",
  manualGrade,
  canPauseAutograding = false,
  initialLoading = false,
  nonSubmittersLoading = false,
  page = 0,
  pageSize = Number.MAX_SAFE_INTEGER,
  onPageChange = () => {},
  onPageSizeChange = () => {},
  sort = "name-asc",
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
  // Passing bar as a fraction of max (e.g., 1.0 = full marks); drives score badge
  // color. `null`/omitted means no passing threshold (badges render neutral).
  thresholdFraction?: number | null
  // Whether a search/filter is currently narrowing the set. Distinguishes the
  // empty state's "filters hide everything" case (offer Clear) from "nothing
  // collected yet" (guide to Collect now) — the table only receives already
  // filtered rows, so it can't infer this itself.
  filtered?: boolean
  // Clears the active search + filters (wired to the controls' clearAll).
  onClearFilters?: () => void
  // The assignment skips built-in grading (empty_repo OR no_autograder): score
  // badges and the regrade action are hidden. Fed skipsGrading by the page. Note
  // no_autograder repos are templated and keep the Feedback PR — the wire flag
  // this receives is skipsGrading, not empty_repo alone.
  emptyRepo?: boolean
  // The assignment's submission_mode, enabling the per-repo "Update
  // autograding trigger" action in the manage hub. Omitted (action hidden)
  // for custom-autograder assignments and non-owners.
  submissionMode?: SubmissionMode
  // The assignment's milestone submission_tags for the same action.
  submissionTags?: string[]
  // The assignment's real submission_mode (independent of the autograder gate
  // that shapes `submissionMode` above). Drives the type-aware count wording
  // and the submission-details modal. Absent reads as every-push.
  assignmentMode?: SubmissionMode
  // When set, the assignment is graded MANUALLY and the viewer may enter/edit
  // scores inline. Carries the write context (org/classroom/assignment/type/
  // max points). Omitted for autograded assignments or a viewer who can't write.
  manualGrade?: ManualGradeContext
  // Whether the per-row Pause/Resume-autograding action applies. Gated by the
  // page (owner + individual + resolved default-autograder), matching the bulk
  // pause/resume gate so the row and menu entry points stay in lockstep — the
  // GitHub workflow enable/disable acts on the individual repo's shim, which a
  // group assignment's founder-managed repo doesn't have in the same way.
  canPauseAutograding?: boolean
  // Core data (snapshot + roster) is still loading on first paint; render a
  // loading state rather than the "no submissions" empty state, which would
  // otherwise flash before data arrives.
  initialLoading?: boolean
  // The "not submitted" list is still resolving from the live/group fan-outs;
  // render a resolving affordance instead of prematurely listing students who
  // may reclassify to submitted/pending.
  nonSubmittersLoading?: boolean
  // Client-side pagination over the combined display list (submitters, then
  // non-submitters, then group repos). `page` is 0-based; the caller owns the
  // state and resets it on filter/sort/size change. Optional — omitting them
  // (e.g., in tests) renders every row on one page with no pager.
  page?: number
  pageSize?: number
  onPageChange?: (page: number) => void
  onPageSizeChange?: (pageSize: number) => void
  // The active sort. Individual assignments render one row per roster student in
  // name order under "name-asc" (the live-eligible view); any other sort renders
  // the sorted submitted rows then non-submitters (a static snapshot view).
  sort?: SubmissionSort
}) => {
  const { t } = useTranslation()
  const passBar = thresholdFraction ?? null

  // The submission whose type-aware details modal is open, or null. Captured
  // from the row so the modal renders without re-deriving.
  const [detailsContext, setDetailsContext] =
    useState<SubmissionDetailsContext | null>(null)

  // The owner (group founder) whose collaborators modal is open, or null.
  const [manageOwner, setManageOwner] = useState<string | null>(null)

  // The submission whose hub (ManageSubmissionModal) is open, or null. Carries
  // the row's context so the hub can render identity, repo, and the per-action
  // gating without re-deriving it.
  const [manageSubmission, setManageSubmission] =
    useState<ManageSubmissionContext | null>(null)

  // The individual student whose repo-access modal is open, or null.
  const [accessOwner, setAccessOwner] = useState<string | null>(null)

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

  // The display list rendered as one paginated sequence. For a group assignment
  // it's submitted group rows then unsubmitted group repos. For an individual
  // assignment in the default name order it's one row per roster student
  // (submitters and non-submitters interleaved by roster name) — the same
  // ordering the live fan-out pages over. Under any other sort (a static
  // snapshot view; live is off then) fall back to sorted submitters first, then
  // non-submitters, preserving the chosen order.
  const displayItems = useMemo(() => {
    if (isGroup) {
      return sort === "name-asc"
        ? buildGroupRosterDisplayItems(scores, unsubmittedGroupRepos, students)
        : buildGroupDisplayItems(scores, unsubmittedGroupRepos)
    }
    if (sort === "name-asc") {
      return buildRosterDisplayItems(students, scores, nonSubmitters)
    }
    return buildSortedDisplayItems(scores, nonSubmitters)
  }, [isGroup, sort, students, scores, nonSubmitters, unsubmittedGroupRepos])
  const bounds = pageBounds(displayItems.length, pageSize, page)
  const pageItems = useMemo(
    () => paginateDisplayItems(displayItems, pageSize, page),
    [displayItems, pageSize, page],
  )
  // Show the pager only once there's more than a page of rows and we're past the
  // loading/empty states (which own the whole table body).
  const showPager =
    !initialLoading && !nonSubmittersLoading && displayItems.length > pageSize

  // One submitted/pending row. Extracted so the paginated sequence can render
  // it inline alongside non-submitter and group-repo rows without duplicating
  // this markup. Keyed by owner by the caller.
  const renderSubmitterRow = ({
    usernames,
    score,
    datetime,
    submissionCount,
    late,
    ...rest
  }: SubmissionRow) => {
    const repo = studentRepoName(classroom, assignment, rest.owner)
    const repoHref = studentRepoUrl(org, classroom, assignment, rest.owner)
    // Open the type-aware submission-details modal for this row. Always
    // available (even for 0/1 submissions), so the count chip has one
    // predictable behavior; the modal itself renders the empty state.
    const openDetails = () =>
      setDetailsContext({
        owner: rest.owner,
        title: isGroup ? repo : getName(rest.owner, students) || rest.owner,
        subtitle: isGroup
          ? undefined
          : identitySubtitle(
              getName(rest.owner, students),
              rest.owner,
              getSection(rest.owner, students),
            ),
        repo,
        repoHref,
        items: buildDetailItems(
          { usernames, score, datetime, submissionCount, late, ...rest },
          assignmentMode,
          org,
          repo,
          t,
        ),
      })
    return (
      <tr key={rest.owner}>
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
          <SubmissionCountCell
            mode={assignmentMode}
            count={submissionCount}
            onOpen={openDetails}
            staleCount={rest.staleCount}
          />
        </td>
        <td>
          {emptyRepo ? (
            <span
              className="text-base-content/50"
              title={t("submissions.table.noGradingTitle")}
            >
              —
            </span>
          ) : manualGrade && !(isGroup && rest.pending) ? (
            // A pending GROUP row comes from the live/detection overlay before
            // collection, so its `usernames` is just the founder ([owner]) —
            // the real members aren't known yet. Grading it here would write
            // member_usernames:[founder] and mis-credit the group (the other
            // members would read as non-submitters and never see the grade),
            // so fall through to the pending badge until collection resolves
            // the member list. Individual pending rows and any collected group
            // row are safe to grade inline.
            <ManualGradeCell
              owner={rest.owner}
              score={score}
              max={rest["max-score"]}
              hasGrade={!rest.pending}
              thresholdFraction={passBar}
              ctx={{ ...manualGrade, memberUsernames: usernames }}
            />
          ) : rest.pending ? (
            <Badge ghost title={t("submissions.table.pendingGradeTitle")}>
              {t("submissions.table.pendingGrade")}
            </Badge>
          ) : (
            <div className="flex items-center gap-1.5">
              <ScoreBadge
                score={score}
                max={rest["max-score"]}
                thresholdFraction={passBar}
              />
              {rest.overridden ? (
                <Badge
                  ghost
                  size="sm"
                  title={t("submissions.table.overriddenTitle")}
                >
                  {t("submissions.table.overridden")}
                </Badge>
              ) : null}
            </div>
          )}
        </td>
        <td>
          <LastSubmittedCell
            datetime={datetime}
            late={late}
            gradedAt={rest.gradedAt}
            liveLatestAt={rest.liveLatestAt}
          />
        </td>
        <td>
          <div className="flex items-center gap-1">
            {isGroup ? (
              <RepoRowActions
                owner={rest.owner}
                release={rest.release}
                skipsGrading={emptyRepo}
                header={<GroupActionControls repo={repo} repoHref={repoHref} />}
                onManage={() =>
                  setManageSubmission({
                    owner: rest.owner,
                    isGroup: true,
                    title: repo,
                    repo,
                    repoHref,
                    hasRepo: true,
                    commit: rest.commit,
                    release: rest.release,
                  })
                }
              />
            ) : (
              <RepoRowActions
                owner={rest.owner}
                release={rest.release}
                skipsGrading={emptyRepo}
                header={
                  <IndividualRowHeader
                    repo={repo}
                    repoHref={repoHref}
                    hasRepo
                  />
                }
                onManage={() =>
                  setManageSubmission({
                    owner: rest.owner,
                    isGroup: false,
                    title: getName(rest.owner, students) || rest.owner,
                    subtitle: identitySubtitle(
                      getName(rest.owner, students),
                      rest.owner,
                      getSection(rest.owner, students),
                    ),
                    repo,
                    repoHref,
                    hasRepo: true,
                    commit: rest.commit,
                    release: rest.release,
                    displayName: getName(rest.owner, students) || undefined,
                  })
                }
              />
            )}
          </div>
        </td>
      </tr>
    )
  }

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
            {initialLoading && (
              <tr>
                <td colSpan={5} className="py-10 text-center">
                  <div className="mx-auto flex max-w-sm flex-col items-center gap-2">
                    <Spinner size="md" />
                    <p className="text-sm text-base-content/70">
                      {t("submissions.table.loading")}
                    </p>
                  </div>
                </td>
              </tr>
            )}
            {!initialLoading &&
              !scores?.length &&
              !nonSubmitters.length &&
              !unsubmittedGroupRepos.length &&
              !nonSubmittersLoading && (
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
            {pageItems.map((item) => {
              if (item.kind === "row") return renderSubmitterRow(item.row)
              if (item.kind === "nonSubmitter") {
                const student = item.student
                // Individual non-submitter: show the same per-repo action
                // cluster as a submitter, disabled where inapplicable. A repo
                // exists only if they accepted; a never-accepted student's
                // repo-scoped actions render disabled. A group non-submitter has
                // no per-student repo, so no actions (the row shows an em-dash).
                //
                // Acceptance is a tri-state: `acceptedUsernames` is undefined
                // until the org repo list loads. Treat undefined as "unknown"
                // and fall back to the em-dash (like the neutral "Not submitted"
                // badge does), so the row never asserts "hasn't accepted" with a
                // disabled cluster while acceptance is still resolving.
                const showActions =
                  !isGroup && Boolean(student.username) && acceptedUsernames

                let actions: React.ReactNode
                if (showActions) {
                  const repoName = studentRepoName(
                    classroom,
                    assignment,
                    student.username,
                  )
                  const repoHref = studentRepoUrl(
                    org,
                    classroom,
                    assignment,
                    student.username,
                  )
                  const accepted = hasAccepted(student.username, showActions)
                  actions = (
                    <RepoRowActions
                      owner={student.username}
                      skipsGrading={emptyRepo}
                      header={
                        <IndividualRowHeader
                          repo={repoName}
                          repoHref={repoHref}
                          hasRepo={accepted}
                        />
                      }
                      onManage={() =>
                        setManageSubmission({
                          owner: student.username,
                          isGroup: false,
                          title:
                            getName(student.username, students) ||
                            student.username,
                          subtitle: identitySubtitle(
                            getName(student.username, students),
                            student.username,
                            student.section,
                          ),
                          repo: repoName,
                          repoHref,
                          hasRepo: accepted,
                          displayName:
                            getName(student.username, students) || undefined,
                        })
                      }
                    />
                  )
                }
                return (
                  <NonSubmitterRow
                    key={`missing-${student.username || student.email || student.github_id}`}
                    student={student}
                    students={students}
                    isGroup={isGroup}
                    acceptedUsernames={acceptedUsernames}
                    onProfile={setProfileUsername}
                    actions={actions}
                    manualGrade={manualGrade}
                  />
                )
              }
              const { owner, repoName } = item.repo
              const groupRepoHref = studentRepoUrl(
                org,
                classroom,
                assignment,
                owner,
              )
              return (
                <GroupRepoRow
                  key={`group-${repoName}`}
                  org={org}
                  classroom={classroom}
                  assignment={assignment}
                  owner={owner}
                  repoName={repoName}
                  students={students}
                  actions={
                    <RepoRowActions
                      owner={owner}
                      skipsGrading={emptyRepo}
                      header={
                        <GroupActionControls
                          repo={repoName}
                          repoHref={groupRepoHref}
                        />
                      }
                      onManage={() =>
                        setManageSubmission({
                          owner,
                          isGroup: true,
                          title: repoName,
                          repo: repoName,
                          repoHref: groupRepoHref,
                          hasRepo: true,
                        })
                      }
                    />
                  }
                />
              )
            })}
            {nonSubmittersLoading && (
              <tr>
                <td
                  colSpan={5}
                  className="py-4 text-center text-sm text-base-content/60"
                >
                  <span className="inline-flex items-center gap-2">
                    <Spinner size="xs" />
                    {t("submissions.table.resolvingNonSubmitters")}
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {showPager && (
          <TablePagination
            page={bounds.page}
            pageCount={bounds.pageCount}
            pageSize={pageSize}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            from={bounds.from}
            to={bounds.to}
            total={bounds.total}
            pages={paginationRange(bounds.page, bounds.pageCount)}
            onPageChange={onPageChange}
            onPageSizeChange={onPageSizeChange}
            className="border-t border-base-content/5"
          />
        )}
      </EnterDiv>

      {detailsContext && (
        <SubmissionDetailsModal
          key={`details-${detailsContext.owner}`}
          onClose={() => setDetailsContext(null)}
          title={detailsContext.title}
          subtitle={detailsContext.subtitle}
          repo={detailsContext.repo}
          repoHref={detailsContext.repoHref}
          // Counts the SUBMISSIONS the listed items represent (a glob group's
          // row counts its N matches via detailItemsCount) so the modal header
          // matches the row's count chip even for a group. This can still differ
          // from the chip when the collected count is live-inflated ahead of
          // what's listable (the "New" stale badge explains that gap).
          countLabel={t(submissionModeCountKey(assignmentMode), {
            count: detailItemsCount(detailsContext.items),
          })}
          items={detailsContext.items}
          {...submissionEmptyState(
            assignmentMode,
            org,
            detailsContext.repo,
            detailsContext.repoHref,
            t,
          )}
        />
      )}

      {manageSubmission && (
        <ManageSubmissionModal
          key={`manage-${manageSubmission.owner}`}
          onClose={() => setManageSubmission(null)}
          title={manageSubmission.title}
          subtitle={manageSubmission.subtitle}
          repo={manageSubmission.repo}
          repoHref={
            manageSubmission.hasRepo ? manageSubmission.repoHref : undefined
          }
          isGroup={manageSubmission.isGroup}
          students={students}
          subModalOpen={
            accessOwner === manageSubmission.owner ||
            manageOwner === manageSubmission.owner
          }
          onManageMembers={
            manageSubmission.isGroup
              ? () => setManageOwner(manageSubmission.owner)
              : undefined
          }
          action={{
            mode: manageSubmission.isGroup ? "group" : "individual",
            org,
            classroom,
            assignment,
            owner: manageSubmission.owner,
            repo: manageSubmission.repo,
            hasRepo: manageSubmission.hasRepo,
            commit: manageSubmission.commit,
            release: manageSubmission.release,
            emptyRepo,
            displayName: manageSubmission.displayName,
            onManageAccess: manageSubmission.isGroup
              ? undefined
              : () => setAccessOwner(manageSubmission.owner),
            submissionMode,
            submissionTags,
            canPauseAutograding,
          }}
        />
      )}

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

      {accessOwner && (
        <RepoAccessModal
          key={accessOwner}
          open
          onClose={() => setAccessOwner(null)}
          org={org}
          repoName={studentRepoName(classroom, assignment, accessOwner)}
          repoUrl={studentRepoUrl(org, classroom, assignment, accessOwner)}
          ownerLogin={accessOwner}
          assignmentName={assignmentName}
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
