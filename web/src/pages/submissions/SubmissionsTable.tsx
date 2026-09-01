import { FilterRemoveIcon, InboxIcon } from "@/components/ui/icons"
import { EmptyState } from "@/components/list"
import { motion } from "motion/react"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  getName,
  getDisplayName,
  getInitials,
  getSection,
  resolveStudent,
} from "@/util/students"
import { studentRepoName, studentRepoUrl } from "@/util/studentRepo"
import { repoCommitUrl } from "@/util/orgUrl"
import Avatar from "@/components/avatar"
import {
  Badge,
  Button,
  SkeletonRows,
  SortableTh,
  InlineSpinner,
  TablePagination,
  TableShell,
} from "@/components/ui"
import type { GroupRepo } from "@/pages/submissions/dashboard"
import type { SubmissionSort } from "@/pages/submissions/dashboard"
import {
  buildRosterDisplayItems,
  buildGroupDisplayItems,
  buildGroupRosterDisplayItems,
  buildSortedDisplayItems,
  hasAccepted,
  isNameSort,
  pageBounds,
  paginateDisplayItems,
  paginationRange,
  sortNameMode,
  PAGE_SIZE_OPTIONS,
} from "@/pages/submissions/dashboard"
import {
  GroupActionControls,
  GroupMembers,
  GroupRepoRow,
  NonSubmitterRow,
  PublicRepoBadge,
  TeamMembersCountCell,
  identitySubtitle,
} from "@/pages/submissions/SubmissionsRows"
import {
  IndividualRowHeader,
  RepoRowActions,
} from "@/pages/submissions/SubmissionsRowActions"
import { FeedbackPrIconButton } from "@/pages/submissions/ReviewButton"
import { ManageSubmissionModal } from "@/pages/submissions/ManageSubmissionModal"
import { ScoreBadge as SharedScoreBadge } from "@/pages/submissions/ScoreBadge"
import { ScoreCell } from "@/pages/submissions/ScoreCell"
import {
  ScoreOverrideModal,
  type ScoreOverrideCapability,
} from "@/pages/submissions/ScoreOverrideModal"
import { GroupCollaboratorsModal } from "@/components/modals/GroupCollaboratorsModal"
import { ManageGroupDialog } from "@/pages/manageGroups/ManageGroupDialog"
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
import type { GroupTeamRef } from "@/domain/teams/groupTeams"
import type { Student, SubmissionMode, TeamFormation } from "@/types/classroom"
import { ClickableTr } from "@/lib/motionComponents"
import { isInteractiveEventTarget } from "@/util/interactiveTarget"
import { blockEnter } from "@/lib/motion"

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

// The value snapshot the score-override modal renders from, captured when a
// row's grade cell trigger is clicked. `maxPoints` is already resolved
// (configured for manual, the row's max-score for autograded).
type OverrideModalRow = {
  owner: string
  displayName?: string
  hasGrade: boolean
  score: number
  overridden: boolean
  autogradedScore?: number
  autogradedMax?: number
  // Absent when the row is a pending autograded submission — the modal then
  // asks the teacher to enter the max.
  maxPoints?: number
  memberUsernames?: string[]
  // Team mode: recorded on a new override entry (scores-v1 `team_slug`).
  teamSlug?: string
}

// Build the type-aware detail items for a row via the shared builder: tag
// entries in tag mode, default-branch commits otherwise.
//
// The list is driven by the DETECTED entries (`row.detectedEntries`) — the same
// source the count chip is bumped from — so it lists exactly what the chip
// counts, even before a collect ingests them; a detected push folds in a "View
// grade" link when a collected attempt at that sha carries a graded release.
// A viewer without the detection overlay (a non-owner, or the owner before
// detection resolves) falls back to the collected `submissions`, so the modal
// never shows a false "no submissions" state beside a positive count chip.
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
          datetime: e.datetime,
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

// Resolve whether a row's score cell offers override editing, and with what
// max. Returns null when the row isn't editable (no capability, or a pending
// group whose members aren't resolved yet). Manual mode is always editable (an
// ungraded row offers "Add grade") with the configured max. Autograded mode is
// editable for any non-empty repo: a graded row uses its own max-score, while a
// pending row (not yet collected, no max-score) returns an undefined max so the
// modal prompts the teacher to enter it.
//
// The pending-group guard matters: a pending group row comes from the
// live/detection overlay before collection, so its usernames is just the
// founder — grading it would write member_usernames:[founder] and mis-credit
// the group, so we defer until collection resolves the member list.
function resolveOverrideCell(
  row: Pick<SubmissionRow, "pending" | "max-score">,
  capability: ScoreOverrideCapability | undefined,
  isGroup: boolean,
  skipsGrading: boolean,
): { hasGrade: boolean; maxPoints?: number } | null {
  if (!capability) return null
  if (isGroup && row.pending) return null

  if (capability.mode === "manual") {
    if (typeof capability.maxPoints !== "number") return null
    return { hasGrade: !row.pending, maxPoints: capability.maxPoints }
  }

  // Autograded override. A never-graded empty repo can't produce a score.
  if (skipsGrading) return null
  // A pending row has no collected max yet: the teacher enters it in the modal.
  if (row.pending) return { hasGrade: false, maxPoints: undefined }
  // A collected row uses its own max-score as the bound.
  if (!(row["max-score"] > 0)) return null
  return { hasGrade: true, maxPoints: row["max-score"] }
}

const SKELETON_BARS = [
  "h-4 w-40",
  "h-6 w-20",
  "h-6 w-16",
  "h-4 w-32",
  "h-8 w-24",
]

// Team mode adds the Members column between the name and Submissions.
const TEAM_SKELETON_BARS = [
  "h-4 w-40",
  "h-6 w-10",
  "h-6 w-20",
  "h-6 w-16",
  "h-4 w-32",
  "h-8 w-24",
]

const SubmissionsTable = ({
  scores,
  students,
  nonSubmitters = [],
  unsubmittedGroupRepos = [],
  isGroup = false,
  isTeam = false,
  groupDisplayNames,
  groupMemberLogins,
  teamsByOwner,
  teamFormation,
  org,
  classroom,
  assignment,
  assignmentName,
  maxGroupSize,
  acceptedUsernames,
  thresholdFraction,
  filtered = false,
  onClearFilters,
  skipsGrading = false,
  emptyRepoAssignment = false,
  submissionMode,
  submissionTags,
  assignmentMode = "every-push",
  overrideGrade,
  canPauseAutograding = false,
  canChangeVisibility = false,
  publicRepoNames,
  initialLoading = false,
  nonSubmittersLoading = false,
  page = 0,
  pageSize = Number.MAX_SAFE_INTEGER,
  onPageChange = () => {},
  onPageSizeChange = () => {},
  sort = "name-first",
  onSortChange,
  viewSignature = "",
  settling = false,
}: {
  scores: SubmissionRow[]
  students: Student[]
  nonSubmitters?: Student[]
  // Group repos that exist but have no submission yet (group assignments only).
  // Rendered as extra rows so teachers see teams that formed before any push.
  unsubmittedGroupRepos?: GroupRepo[]
  isGroup?: boolean
  // TEAM mode (a group flavor): members come from live team membership, the
  // display name from the team record, and the legacy collaborators modal is
  // never offered. isGroup is also true for team rows.
  isTeam?: boolean
  // Team mode: owner segment ("group-<n>", lowercased) -> the team's display
  // name / live member logins.
  groupDisplayNames?: ReadonlyMap<string, string>
  groupMemberLogins?: ReadonlyMap<string, string[]>
  // Team mode: owner segment -> the full team ref (slug recorded on override
  // entries; the whole ref feeds the shared manage-group dialog).
  teamsByOwner?: ReadonlyMap<string, GroupTeamRef>
  // Team mode: the assignment's team_formation, recorded on the teams.json
  // snapshot writes the manage dialog triggers.
  teamFormation?: TeamFormation
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
  // badges and the grading actions (details/regrade) are hidden.
  skipsGrading?: boolean
  // The narrower bare-repo case (empty_repo alone): also hides the hub's repo
  // actions (Review/Manage access). A no_autograder repo is templated and keeps
  // the Feedback PR, so it must NOT set this — mirrors the page's bulk gates.
  emptyRepoAssignment?: boolean
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
  // When set, the viewer may override scores (manual-mode grading, or
  // overriding an autograded result). Carries the write context and how to
  // compute the max (configured for manual, per-row for autograded). Omitted
  // for a non-gradable assignment or a viewer who can't write.
  overrideGrade?: ScoreOverrideCapability
  // Whether the per-row Pause/Resume-autograding action applies. Gated by the
  // page (owner + individual + resolved default-autograder), matching the bulk
  // pause/resume gate so the row and menu entry points stay in lockstep — the
  // GitHub workflow enable/disable acts on the individual repo's shim, which a
  // group assignment's founder-managed repo doesn't have in the same way.
  canPauseAutograding?: boolean
  // Whether the manage hub's Change-visibility action applies (issue #766).
  // Gated by the page on org OWNER only — org policy blocks members from
  // flipping visibility, and GitHub 403s them regardless.
  canChangeVisibility?: boolean
  // Lowercased names of this assignment's repos that are currently PUBLIC
  // (derived from the org repo list). Rows whose repo is in the set show the
  // warning badge; undefined/absent renders no badges (list still loading).
  publicRepoNames?: ReadonlySet<string>
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
  // name order under a name sort (the live-eligible view); a time sort renders
  // the sorted submitted rows then non-submitters (a static snapshot view).
  sort?: SubmissionSort
  // Column-header sorting (Student toggles first/last name, Last submitted
  // toggles recent/oldest). Omitted, the headers render as static text and
  // the toolbar select stays the only sort control.
  onSortChange?: (sort: SubmissionSort) => void
  // A signature of the current view (filter/sort/size/assignment — NOT the
  // search text, which changes per keystroke and would remount the rows mid-
  // typing) from the page. Combined with `page` it keys the row container, so
  // the rows re-stagger their entrance whenever the view changes. Empty (the
  // default) means the container never re-keys — fine for tests that render a
  // single static page.
  viewSignature?: string
  // The current page's live/detected submission data is still resolving, so the
  // volatile submitter cells (count, last-submitted) shimmer until they settle.
  // Off for non-live views and already-settled pages.
  settling?: boolean
}) => {
  const { t } = useTranslation()
  const passBar = thresholdFraction ?? null

  // Format the row identity as "Last, First" only under a last-name sort, so the
  // label reads in the order it sorts; "First Last" otherwise (name-first and
  // time sorts). sortNameMode already maps time sorts to "first".
  const nameDisplayMode = sortNameMode(sort)

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

  // The row whose score-override modal is open, or null. Captures the value
  // snapshot so the modal renders without re-deriving from the row list.
  const [overrideRow, setOverrideRow] = useState<OverrideModalRow | null>(null)
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
  // assignment in a name order it's one row per roster student (submitters and
  // non-submitters interleaved by roster name, in the active first/last mode) —
  // the same ordering the live fan-out pages over. Under a time sort (a static
  // snapshot view; live is off then) fall back to sorted submitters first, then
  // non-submitters, preserving the chosen order.
  const displayItems = useMemo(() => {
    if (isGroup) {
      return isNameSort(sort)
        ? buildGroupRosterDisplayItems(
            scores,
            unsubmittedGroupRepos,
            students,
            sortNameMode(sort),
          )
        : buildGroupDisplayItems(scores, unsubmittedGroupRepos)
    }
    if (isNameSort(sort)) {
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

  // The per-row Feedback-PR shortcut (issue #741), shared by every row family.
  // An empty_repo assignment has no Feedback PR, so the shortcut is omitted
  // entirely — mirrors the hub's Review gate.
  const feedbackPrShortcut = (repo: string, hasRepo: boolean) =>
    emptyRepoAssignment ? undefined : (
      <FeedbackPrIconButton
        org={org}
        repo={repo}
        mode={isGroup ? "group" : "individual"}
        hasRepo={hasRepo}
      />
    )

  // Whether a row's repo is currently PUBLIC (issue #766), for the warning
  // badge shared by every row family. False while the set is still loading.
  const isPublicRepo = (repoName: string) =>
    Boolean(publicRepoNames?.has(repoName.toLowerCase()))

  // A group row's display label: the team's record name for team mode
  // ("Group <n>" default supplied by the page), else the repo name.
  const groupLabel = (owner: string, repo: string) =>
    groupDisplayNames?.get(owner.toLowerCase()) ?? repo

  // Team mode: a row's live member logins, or undefined while membership is
  // still unresolved (which blocks the override editor — see below).
  const teamMembers = (owner: string) =>
    groupMemberLogins?.get(owner.toLowerCase())

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
        title: isGroup
          ? groupLabel(rest.owner, repo)
          : getName(rest.owner, students) || rest.owner,
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
    // The row's primary action: the manage-submission modal. Shared by the
    // actions cluster's manage button and the whole-row click.
    const openManage = () =>
      setManageSubmission(
        isGroup
          ? {
              owner: rest.owner,
              isGroup: true,
              title: groupLabel(rest.owner, repo),
              repo,
              repoHref,
              hasRepo: true,
              commit: rest.commit,
              release: rest.release,
              displayName: groupDisplayNames?.get(rest.owner.toLowerCase()),
            }
          : {
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
            },
      )
    return (
      <ClickableTr
        key={rest.owner}
        className="hover:bg-base-200"
        // Mouse convenience only — the guard yields to inner buttons/links,
        // and the actions cluster keeps manage keyboard-reachable.
        onClick={(event) => {
          if (isInteractiveEventTarget(event)) return
          openManage()
        }}
      >
        <td>
          {isGroup ? (
            <div className="flex flex-col items-start gap-1.5">
              <GroupMembers
                org={org}
                repoName={repo}
                usernames={usernames}
                students={students}
                repoHref={repoHref}
                // Team rows title the group by its display name; the long
                // repo name stays on the link's hover title. Legacy group
                // rows keep the repo name as the label.
                repoLabel={isTeam ? groupLabel(rest.owner, repo) : repo}
                memberLoginsOverride={
                  isTeam ? teamMembers(rest.owner) : undefined
                }
                // Team mode: members render in their own count column.
                showAvatars={!isTeam}
              />
              {isPublicRepo(repo) ? <PublicRepoBadge /> : null}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Avatar
                name={getDisplayName(usernames[0], students, nameDisplayMode)}
                initials={getInitials(usernames[0], students)}
                github={usernames[0]}
                subtitle={identitySubtitle(
                  getName(usernames[0], students),
                  usernames[0],
                  getSection(usernames[0], students),
                )}
                onClick={() => setProfileUsername(usernames[0])}
              />
              {isPublicRepo(repo) ? <PublicRepoBadge /> : null}
            </div>
          )}
        </td>
        {isTeam && (
          // Quarantined from the row's manage click like the actions cell, so
          // the count button is the only click target inside it.
          <td onClick={(event) => event.stopPropagation()}>
            <TeamMembersCountCell
              count={teamMembers(rest.owner)?.length}
              label={t("submissions.table.manageMembersLabel", {
                name: groupLabel(rest.owner, repo),
              })}
              onClick={() => setManageOwner(rest.owner)}
            />
          </td>
        )}
        <td>
          <SubmissionCountCell
            mode={assignmentMode}
            count={submissionCount}
            onOpen={openDetails}
            staleCount={rest.staleCount}
            settling={settling}
          />
        </td>
        <td>
          {(() => {
            const cell = resolveOverrideCell(
              { usernames, score, ...rest } as SubmissionRow,
              overrideGrade,
              isGroup,
              skipsGrading,
            )
            // Team rows credit LIVE team members on an override write, so the
            // editor is blocked until membership resolves — the team analog of
            // the pending-group guard inside resolveOverrideCell.
            const liveTeamMembers = isTeam ? teamMembers(rest.owner) : undefined
            const teamMembersUnresolved = isTeam && !liveTeamMembers
            if (cell && !teamMembersUnresolved) {
              return (
                <ScoreCell
                  owner={rest.owner}
                  hasGrade={cell.hasGrade}
                  pending={Boolean(rest.pending)}
                  score={score}
                  max={rest["max-score"]}
                  overridden={Boolean(rest.overridden)}
                  thresholdFraction={passBar}
                  onEdit={() =>
                    setOverrideRow({
                      owner: rest.owner,
                      displayName: isGroup
                        ? groupLabel(rest.owner, repo)
                        : getName(rest.owner, students) || undefined,
                      hasGrade: cell.hasGrade,
                      score,
                      overridden: Boolean(rest.overridden),
                      autogradedScore: rest.autogradedScore,
                      autogradedMax: rest.autogradedMax,
                      maxPoints: cell.maxPoints,
                      memberUsernames: liveTeamMembers ?? usernames,
                      teamSlug: isTeam
                        ? (rest.teamSlug ??
                          teamsByOwner?.get(rest.owner.toLowerCase())?.slug)
                        : undefined,
                    })
                  }
                />
              )
            }
            return skipsGrading ? (
              <span
                className="text-base-content/50"
                title={t("submissions.table.noGradingTitle")}
              >
                —
              </span>
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
            )
          })()}
        </td>
        <td>
          <LastSubmittedCell
            datetime={datetime}
            late={late}
            gradedAt={rest.gradedAt}
            liveLatestAt={rest.liveLatestAt}
            settling={settling}
          />
        </td>
        {/* The actions cell is quarantined from the row's manage click: a
            near-miss around a small icon (or a disabled icon's retargeted
            click) must not yank the hub open over the action the user aimed
            at — most visibly the repo link's navigation. */}
        <td onClick={(event) => event.stopPropagation()}>
          <div className="flex items-center justify-end gap-1">
            {isGroup ? (
              <RepoRowActions
                owner={rest.owner}
                release={rest.release}
                skipsGrading={skipsGrading}
                header={<GroupActionControls repo={repo} repoHref={repoHref} />}
                feedbackPr={feedbackPrShortcut(repo, true)}
                onManage={openManage}
              />
            ) : (
              <RepoRowActions
                owner={rest.owner}
                release={rest.release}
                skipsGrading={skipsGrading}
                header={
                  <IndividualRowHeader
                    repo={repo}
                    repoHref={repoHref}
                    hasRepo
                  />
                }
                feedbackPr={feedbackPrShortcut(repo, true)}
                onManage={openManage}
              />
            )}
          </div>
        </td>
      </ClickableTr>
    )
  }

  return (
    <>
      {/* The shell's own entrance is off: PageTransition already animates
          navigation and the tbody blockEnter is the data-arrival cue. */}
      <TableShell
        animate={false}
        ariaBusy={initialLoading}
        footer={
          showPager ? (
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
              className="border-t border-base-300"
            />
          ) : undefined
        }
      >
        <caption className="sr-only">
          {isGroup
            ? t("submissions.table.captionGroup")
            : t("submissions.table.captionStudent")}
        </caption>
        <thead>
          {/* Width hints so auto layout doesn't dump all slack into the
                first two columns, stranding Score/Last-submitted/Actions in a
                clump at the far edge. */}
          <tr>
            <SortableTh
              className={isTeam ? "w-[22%]" : "w-[26%]"}
              label={
                isGroup
                  ? t("submissions.table.colGroup")
                  : t("submissions.table.colStudent")
              }
              sort={sort}
              asc="name-first"
              desc="name-last"
              onSortChange={onSortChange}
              title={t("submissions.table.sortByName")}
            />
            {isTeam && (
              <th scope="col" className="w-[10%]">
                {t("submissions.table.colMembers")}
              </th>
            )}
            <th scope="col" className={isTeam ? "w-[18%]" : "w-[24%]"}>
              {t("submissions.table.colSubmissions")}
            </th>
            <th scope="col" className="w-[13%]">
              {t("submissions.table.colScore")}
            </th>
            <SortableTh
              className="w-[19%]"
              label={t("submissions.table.colLastSubmitted")}
              sort={sort}
              asc="oldest"
              desc="recent"
              // A time column activates newest-first.
              initial="recent"
              onSortChange={onSortChange}
              title={t("submissions.table.sortByLastSubmitted")}
            />
            <th scope="col" className="w-[18%]">
              <span className="sr-only">
                {t("submissions.table.colActions")}
              </span>
            </th>
          </tr>
        </thead>
        <motion.tbody
          key={`${viewSignature}:${page}`}
          variants={blockEnter}
          initial="initial"
          animate="animate"
        >
          {initialLoading && (
            <SkeletonRows bars={isTeam ? TEAM_SKELETON_BARS : SKELETON_BARS} />
          )}
          {/* Group mode renders group rows only — the reconciled "no group"
              non-submitters never appear as rows here — so they must not
              suppress the empty state (a groupless class would otherwise get
              a silent blank table). */}
          {!initialLoading &&
            !scores?.length &&
            (isGroup || !nonSubmitters.length) &&
            !unsubmittedGroupRepos.length &&
            !nonSubmittersLoading && (
              <tr>
                <td colSpan={isTeam ? 6 : 5}>
                  {filtered ? (
                    <EmptyState
                      variant="bare"
                      icon={FilterRemoveIcon}
                      titleAs="h3"
                      title={t("submissions.table.emptyFilteredTitle")}
                      body={t("submissions.table.emptyFilteredBody")}
                      action={
                        onClearFilters && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={onClearFilters}
                          >
                            {t("submissions.table.emptyClearFilters")}
                          </Button>
                        )
                      }
                    />
                  ) : (
                    <EmptyState
                      variant="bare"
                      icon={InboxIcon}
                      titleAs="h3"
                      title={
                        isGroup
                          ? t("submissions.table.emptyNoGroupsTitle")
                          : t("submissions.table.emptyNoDataTitle")
                      }
                      body={
                        isGroup
                          ? t("submissions.table.emptyNoGroupsBody")
                          : t("submissions.table.emptyNoDataBody")
                      }
                    />
                  )}
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
              let openManage: (() => void) | undefined
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
                openManage = () =>
                  setManageSubmission({
                    owner: student.username,
                    isGroup: false,
                    title:
                      getName(student.username, students) || student.username,
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
                actions = (
                  <RepoRowActions
                    owner={student.username}
                    skipsGrading={skipsGrading}
                    header={
                      <IndividualRowHeader
                        repo={repoName}
                        repoHref={repoHref}
                        hasRepo={accepted}
                      />
                    }
                    feedbackPr={feedbackPrShortcut(repoName, accepted)}
                    onManage={openManage}
                  />
                )
              }
              return (
                <NonSubmitterRow
                  key={`missing-${student.username || student.email || student.github_id}`}
                  student={student}
                  students={students}
                  isGroup={isGroup}
                  isTeam={isTeam}
                  acceptedUsernames={acceptedUsernames}
                  onProfile={setProfileUsername}
                  actions={actions}
                  onManage={openManage}
                  overrideGrade={overrideGrade}
                  onEditGrade={(username) =>
                    overrideGrade?.mode === "manual" &&
                    typeof overrideGrade.maxPoints === "number"
                      ? setOverrideRow({
                          owner: username,
                          displayName: getName(username, students) || undefined,
                          hasGrade: false,
                          score: 0,
                          overridden: false,
                          maxPoints: overrideGrade.maxPoints,
                        })
                      : undefined
                  }
                  thresholdFraction={passBar}
                  nameMode={nameDisplayMode}
                  publicRepo={
                    Boolean(student.username) &&
                    isPublicRepo(
                      studentRepoName(classroom, assignment, student.username),
                    )
                  }
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
            const openManage = () =>
              setManageSubmission({
                owner,
                isGroup: true,
                title: groupLabel(owner, repoName),
                repo: repoName,
                repoHref: groupRepoHref,
                hasRepo: true,
                displayName: groupDisplayNames?.get(owner.toLowerCase()),
              })
            return (
              <GroupRepoRow
                key={`group-${repoName}`}
                org={org}
                classroom={classroom}
                assignment={assignment}
                owner={owner}
                repoName={repoName}
                students={students}
                onManage={openManage}
                publicRepo={isPublicRepo(repoName)}
                memberLogins={isTeam ? teamMembers(owner) : undefined}
                label={isTeam ? groupLabel(owner, repoName) : undefined}
                membersCell={
                  isTeam ? (
                    <TeamMembersCountCell
                      count={teamMembers(owner)?.length}
                      label={t("submissions.table.manageMembersLabel", {
                        name: groupLabel(owner, repoName),
                      })}
                      onClick={() => setManageOwner(owner)}
                    />
                  ) : undefined
                }
                actions={
                  <RepoRowActions
                    owner={owner}
                    skipsGrading={skipsGrading}
                    header={
                      <GroupActionControls
                        repo={repoName}
                        repoHref={groupRepoHref}
                      />
                    }
                    feedbackPr={feedbackPrShortcut(repoName, true)}
                    onManage={openManage}
                  />
                }
              />
            )
          })}
          {nonSubmittersLoading && (
            <tr>
              <td
                colSpan={isTeam ? 6 : 5}
                className="py-4 text-center text-sm text-base-content/60"
              >
                <span role="status" className="inline-flex items-center gap-2">
                  <InlineSpinner />
                  {t("submissions.table.resolvingNonSubmitters")}
                </span>
              </td>
            </tr>
          )}
        </motion.tbody>
      </TableShell>

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
            // Group flavors both get a members editor: legacy group edits
            // direct collaborators, team mode opens the shared manage-group
            // dialog (ManageGroupDialog).
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
            skipsGrading,
            emptyRepoAssignment,
            displayName: manageSubmission.displayName,
            onManageAccess: manageSubmission.isGroup
              ? undefined
              : () => setAccessOwner(manageSubmission.owner),
            submissionMode,
            submissionTags,
            canPauseAutograding,
            canChangeVisibility,
          }}
        />
      )}

      {isGroup && !isTeam && manageOwner && (
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

      {isTeam &&
        manageOwner &&
        (() => {
          const team = teamsByOwner?.get(manageOwner.toLowerCase())
          if (!team) return null
          return (
            <ManageGroupDialog
              key={manageOwner}
              org={org}
              classroom={classroom}
              assignment={assignment}
              team={team}
              formation={teamFormation ?? "teacher"}
              maxGroupSize={maxGroupSize}
              onClose={() => setManageOwner(null)}
            />
          )
        })()}

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

      {overrideRow && overrideGrade && (
        <ScoreOverrideModal
          key={`override-${overrideRow.owner}`}
          open
          onClose={() => setOverrideRow(null)}
          owner={overrideRow.owner}
          displayName={overrideRow.displayName}
          hasGrade={overrideRow.hasGrade}
          score={overrideRow.score}
          overridden={overrideRow.overridden}
          autogradedScore={overrideRow.autogradedScore}
          autogradedMax={overrideRow.autogradedMax}
          thresholdFraction={passBar}
          ctx={{
            org: overrideGrade.org,
            classroom: overrideGrade.classroom,
            assignment: overrideGrade.assignment,
            assignmentType: overrideGrade.assignmentType,
            mode: overrideGrade.mode,
            maxPoints: overrideRow.maxPoints,
            memberUsernames: overrideRow.memberUsernames,
            teamSlug: overrideRow.teamSlug,
          }}
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
