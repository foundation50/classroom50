import { useEffect, useMemo, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import Papa from "papaparse"

import { useParams, Navigate } from "@tanstack/react-router"

import Breadcrumb from "@/components/breadcrumb"
import PageHeader from "@/components/PageHeader"
import PageShell from "@/components/PageShell"
import MissingParams from "@/components/MissingParams"
import { Alert, Badge, Spinner } from "@/components/ui"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import SubmissionsTable from "@/pages/submissions/SubmissionsTable"
import SubmissionsControls from "@/pages/submissions/SubmissionsControls"
import { SubmissionsActionsMenu } from "@/pages/submissions/SubmissionsActionsMenu"
import { AcceptLinkModal } from "@/pages/submissions/AcceptLinkModal"
import { MetricsModal } from "@/pages/submissions/MetricsModal"
import { DataFreshness } from "@/pages/submissions/DataFreshness"
import { ConfirmModal } from "@/components/modals"
import {
  DEFAULT_FILTERS,
  DEFAULT_PAGE_SIZE,
  acceptedRosterCount,
  acceptedUsernames,
  buildScoresCsvRows,
  buildSectionLookup,
  classAverage,
  computeStats,
  displayPageOwners,
  distinctSections,
  existingGroupRepos,
  filterAndSortRows,
  filterNonSubmitters,
  hasAccepted,
  latestAssignmentPush,
  mergeLiveRows,
  reconcileNonSubmitters,
  rosterScopedRows,
  rowInSection,
  selectActiveWorkflowAction,
  showsNonSubmitters,
  snapshotIsStale,
  studentInSection,
  type SubmissionFilters,
  type SubmissionSort,
} from "@/pages/submissions/dashboard"
import useGetScores from "@/hooks/useGetScores"
import useLiveSubmissions from "@/hooks/useLiveSubmissions"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import useGetClassroom from "@/hooks/useGetClassroom"
import useGetStudents from "@/hooks/useGetStudents"
import { useTeamRoster } from "@/hooks/useTeamRoster"
import { rowToStudent } from "@/util/teamRoster"
import { getName, sortStudentsByName } from "@/util/students"
import { hasStudentEnrollment } from "@/util/classroomRoleUI"
import type { Student } from "@/types/classroom"
import useEmptyRosterWarning from "@/hooks/useEmptyRosterWarning"
import { EmptyRosterNotice } from "@/components/EmptyRosterNotice"
import { QueryErrorAlert } from "@/components/QueryErrorAlert"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import { useGroupRepoMemberLogins } from "@/hooks/useGroupRepoMembers"
import useTriggerScoreCollection from "@/hooks/useTriggerScoreCollection"
import useTriggerRegrade from "@/hooks/useTriggerRegrade"
import { RegradeCoordinatorProvider } from "@/context/regrade/RegradeCoordinator"
import useGetLastCollectScoresRun from "@/hooks/useGetLastCollectScoresRun"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import { useIsOrgOwner } from "@/context/githubOrgRole/useIsOrgOwner"
import { can } from "@/authz"
import RoleResolvingFallback from "@/components/RoleResolvingFallback"
import {
  COLLECT_SCORES_WORKFLOW,
  REGRADE_WORKFLOW,
} from "@/github-core/workflows"
import {
  formatDueDateTime,
  formatRelativeToNow,
  isPastDue,
  dueDeadlineInstant,
} from "@/util/formatDate"
import { githubTemplateRepoUrl } from "@/util/orgUrl"
import { CONFIG_REPO } from "@/util/configRepo"
import { GitHubLink } from "@/components/GitHubLink"

// Stable empty set for the live non-submitter filter (accepted axis is "all"
// when live, so no accepted-set membership is consulted). Module-level so its
// identity is stable across renders and doesn't churn the memo.
const EMPTY_SET: Set<string> = new Set()

const SubmissionsPageContent = () => {
  const { t } = useTranslation()
  const { org, classroom, assignment } = useParams({ strict: false })
  // Regrade-all is a config-repo-write tier action (teacher|hta); Collect and
  // per-row regrade stay all-staff (the page already gates entry on
  // viewClassroomStaffContent). GitHub is the real enforcer; this is the UX gate.
  const { role: classroomRole } = useClassroomRoleContext()
  const canRegradeAll = can("authorAssignments", { classroomRole })
  // Live reads (submit/* releases) hit student repos with the VIEWER's personal
  // token. Only an org owner is admin on every repo and can read them; a TA/HTA
  // is granted per-repo read at collect time but can't enumerate the org, so
  // their live fan-out would 404. So the live overlay is owner-only — non-owners
  // render purely from the collected snapshot. `isOwner` is fail-closed: false
  // until the org role is CONFIRMED owner, so the page shows the snapshot without
  // a live flash while the role resolves.
  const { isOwner } = useIsOrgOwner()
  const {
    data: scoresData,
    refetch: refetchScores,
    isError: scoresError,
    error: scoresErrorObj,
  } = useGetScores(org, classroom)
  const { data: assignmentData } = useGetClassroomAssignments(org, classroom)
  // Team-driven usernames: the classroom GitHub team is authoritative for
  // enrollment; roster.csv enriches display only. The dashboard consumes
  // Student[], so map enrolled team rows into that shape.
  // Restrict to rows carrying a STUDENT enrollment — a pure teacher/TA is an
  // enrolled team member but not a gradee, and "Collect scores" already runs
  // only against the student team, so excluding them keeps this roster in step
  // with what's actually graded (a student who is also staff still counts).
  const { students: csvStudents } = useGetStudents(org, classroom)
  // Surface the team fetch's error/loading: a transient or permission failure
  // of the enrolled source of truth must render as error+retry, not an
  // authoritative empty roster.
  const {
    rows: teamRows,
    isLoading: rosterLoading,
    isError: rosterError,
    refetch: refetchRoster,
  } = useTeamRoster(org ?? "", classroom ?? "", csvStudents)
  const students: Student[] = useMemo(
    () =>
      sortStudentsByName(
        teamRows
          .filter((r) => r.state === "enrolled" && hasStudentEnrollment(r))
          .map(rowToStudent),
      ),
    [teamRows],
  )
  // Gate Regrade all / Collect now on an empty roster: dispatching with no
  // students is wasted effort. `show` is loading-aware (won't flash before the
  // roster resolves).
  const emptyRoster = useEmptyRosterWarning(org, classroom)
  // Teacher-only page, so reading the classroom's capability-URL secret from
  // classroom.json is fine. For a protected classroom the shared accept link
  // must carry the key as `?k=<secret>`, else students hit "not found".
  const { data: classroomMeta } = useGetClassroom(org, classroom)
  const secret = classroomMeta?.secret

  const assignmentSubmitUrl =
    `${window.location.origin}/${org}/${classroom}/assignments/${assignment}/accept` +
    (secret ? `?k=${secret}` : "")
  // CLI equivalent of the browser accept link, for students who prefer it.
  const assignmentSubmitCli =
    `gh student accept ${org} ${classroom} ${assignment}` +
    (secret ? ` --key ${secret}` : "")

  // Toolbar modals: metrics + accept-link are consolidated behind buttons so
  // the roster surfaces near the top instead of below stat cards and the
  // accept disclosure.
  const [metricsOpen, setMetricsOpen] = useState(false)
  const [acceptOpen, setAcceptOpen] = useState(false)

  const assignmentInfo = assignmentData?.assignments.find(
    (a) => a.slug === assignment,
  )
  const isGroupAssignment = assignmentInfo?.mode === "group"
  // empty_repo assignments never autograde: repos were created bare, with no
  // autograde workflow. Grading UI (Regrade all, per-row regrade, scores,
  // Feedback PR) is hidden and a notice explains why. Collect stays enabled —
  // it's org-wide and collect_scores.py skips this assignment itself.
  const isEmptyRepoAssignment = assignmentInfo?.empty_repo === true
  // Scope the collector's scores to the CURRENT roster (see rosterScopedRows).
  // Gate on a resolved roster so a transient load/permission failure falls back
  // to unscoped rows rather than blanking a populated gradebook.
  const rosterReady = !rosterLoading && !rosterError
  const snapshotRows = useMemo(() => {
    return scoresData?.submissions?.[assignment ?? ""] || []
  }, [scoresData, assignment])

  // Dashboard controls — all client-side over already-loaded data. Declared
  // early because the live fan-out below is coupled to the current table page:
  // it reads only the repos on the page you're viewing (see livePageOwners), so
  // the page/size/filters must be known before it runs.
  const [query, setQuery] = useState("")
  const [filters, setFilters] = useState<SubmissionFilters>(DEFAULT_FILTERS)
  const [sort, setSort] = useState<SubmissionSort>("name-asc")
  // Client-side table pagination over the display list. `page` is 0-based;
  // clamped at render (pageBounds) so a filter that shrinks the list can't
  // strand the view on an empty page.
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  // Reset to the first page whenever the visible set changes (new search,
  // filter, sort, page size, a different assignment, or live-capability
  // resolving — which re-pins the effective sort/status and reshapes the rows).
  // Done render-purely via a stored view signature (setState-during-render, not
  // an effect) so the reset lands in the same commit as the change — no extra
  // render, and no setState-in-effect. React bails out of the re-render once the
  // signature matches.
  const viewSignature = `${query}|${JSON.stringify(filters)}|${sort}|${pageSize}|${assignment ?? ""}|${isOwner && !isEmptyRepoAssignment}`
  const [lastViewSignature, setLastViewSignature] = useState(viewSignature)
  if (viewSignature !== lastViewSignature) {
    setLastViewSignature(viewSignature)
    setPage(0)
  }

  // Section filtering: distinct sections for the dropdown, plus a username ->
  // section lookup so submitted rows (which carry only logins) can be matched.
  // Defined early because the page-scoped live fan-out below filters its owner
  // slice by section.
  const sections = useMemo(() => distinctSections(students), [students])
  const sectionByUsername = useMemo(
    () => buildSectionLookup(students),
    [students],
  )

  // Org repo list drives repo-existence signals (individual acceptance below,
  // group-repo enumeration, and the pushed_at staleness heuristic). `refetch` is
  // wired to Sync + collect-completion so `latestPush` isn't frozen at page load
  // (else a push after load never flips the freshness line to "out of sync").
  const { data: orgRepos, refetch: refetchOrgRepos } = useGetOrgRepos(org ?? "")

  // Due-date presentation: absolute date + a relative countdown ("in 3 days" /
  // "2 hours ago"). Past due flips the badge to error and the label to overdue.
  const dueDate = assignmentInfo?.due
  const dueOverdue = dueDate ? isPastDue(dueDate) : false
  const dueRelative = dueDate
    ? formatRelativeToNow(dueDeadlineInstant(dueDate) ?? new Date(dueDate))
    : null

  // Group repos that already exist for this assignment, derived from the org
  // repo list (empty for individual assignments). Named after the founder, so
  // the `owner` segment is a roster login when the founder is enrolled. Sibling
  // assignment slugs are passed so a repo of a slug-extending sibling
  // ("hw1-bonus" under "hw1") isn't mis-attributed here. Computed once so both
  // the non-submitter list (to avoid double-listing a member who has a repo) and
  // the group-repo rows below share one derivation.
  const siblingSlugs = useMemo(
    () => (assignmentData?.assignments ?? []).map((a) => a.slug),
    [assignmentData],
  )
  const groupRepoList = useMemo(
    () =>
      isGroupAssignment
        ? existingGroupRepos(
            orgRepos,
            classroom ?? "",
            assignment ?? "",
            siblingSlugs,
          )
        : [],
    [isGroupAssignment, orgRepos, classroom, assignment, siblingSlugs],
  )

  // Whether the live presence overlay applies here: owner-only (personal token
  // can read the repos) and not an empty_repo assignment (never autograded). A
  // non-owner renders purely from the collected snapshot.
  const liveCapable = isOwner && !isEmptyRepoAssignment

  // When live, the toolbar hides Sort + Status (they can't be reconciled with a
  // page-scoped live fan-out), so the effective order/status are pinned to the
  // plain name-ordered, unfiltered view the fan-out aligns to — even if a prior
  // session left non-default state. Search + section still apply (they don't
  // reorder the spine). Non-live viewers keep full sort/status.
  const effectiveSort: SubmissionSort = liveCapable ? "name-asc" : sort
  const effectiveStatusFilters: SubmissionFilters = useMemo(
    () =>
      liveCapable
        ? { ...filters, submission: "all", passing: "all", accepted: "all" }
        : filters,
    [liveCapable, filters],
  )

  // Live submission presence for THIS assignment, read directly from student
  // repos' submit/* releases — so a student who pushed but hasn't been collected
  // yet still shows as submitted (issue #347). PAGE-SCOPED: the fan-out reads
  // only the repos on the CURRENT table page (#359's burst mitigation), so a
  // large class is read a page at a time. The fanned owner set is the rendered
  // page under the (pinned name-asc) live order, derived from the SNAPSHOT
  // display list so it never loops on its own live results. Owner-only, off for
  // empty_repo.
  const snapshotScoped = useMemo(
    () =>
      rosterReady ? rosterScopedRows(snapshotRows, students) : snapshotRows,
    [rosterReady, snapshotRows, students],
  )
  // Non-submitter pool for the fan-out's display list, filtered by the SAME
  // query + section the rendered table applies (status/passing are neutralized
  // when live, and accept-availability doesn't gate the fan-out) — so the fanned
  // page lines up with the visible page under an active search, not just an
  // empty one. Snapshot-independent (no acceptedSet), so it can't loop on live
  // results. `filterNonSubmitters` with an empty accepted set + accepted:"all"
  // matches only on query + section.
  const liveNonSubmitterPool = useMemo(
    () =>
      filterNonSubmitters(students, query, effectiveStatusFilters, EMPTY_SET),
    [students, query, effectiveStatusFilters],
  )
  const liveOwnerArgs = useMemo(
    () => ({
      isGroup: isGroupAssignment,
      sort: effectiveSort,
      students,
      rows: filterAndSortRows(snapshotScoped, {
        query,
        filters: effectiveStatusFilters,
        sort: effectiveSort,
        students,
        sectionByUsername,
        thresholdFraction: null,
      }),
      nonSubmitters: liveNonSubmitterPool,
      groupRepos: groupRepoList,
    }),
    [
      isGroupAssignment,
      effectiveSort,
      students,
      snapshotScoped,
      query,
      effectiveStatusFilters,
      sectionByUsername,
      groupRepoList,
      liveNonSubmitterPool,
    ],
  )
  const livePageOwners = useMemo(
    () => displayPageOwners({ ...liveOwnerArgs, page, pageSize }),
    [liveOwnerArgs, page, pageSize],
  )
  const {
    submissions: liveSubmissions,
    errorCount: liveErrorCount,
    isPending: livePending,
    refetch: refetchLive,
  } = useLiveSubmissions({
    org,
    classroom,
    assignment,
    repoOwners: livePageOwners,
    // Owner-only, not empty_repo — see liveCapable.
    enabled: liveCapable,
  })

  // Overlay live presence over the snapshot for a live-capable viewer (snapshot
  // wins per owner for GRADES; live adds a pending row for an as-yet-uncollected
  // submitter and bumps stale counts). A non-capable viewer (TA/HTA) uses the
  // collected snapshot ALONE. Then roster-scope, gated on a resolved roster so a
  // transient failure falls back to unscoped rows rather than blanking a
  // populated gradebook.
  const scoresInfo = useMemo(() => {
    const merged = liveCapable
      ? mergeLiveRows(
          snapshotRows,
          liveSubmissions.map((s) => ({
            owner: s.owner,
            datetime: s.submittedAt,
            release: s.releaseUrl,
            submissionCount: s.submissionCount,
          })),
        )
      : snapshotRows
    return rosterReady ? rosterScopedRows(merged, students) : merged
  }, [liveCapable, snapshotRows, liveSubmissions, rosterReady, students])

  // Repos whose latest submission landed after the deadline. `late` is computed
  // upstream (collect_scores.py) from push time, not grade time.
  const lateCount = scoresInfo.filter((row) => row.late).length

  // Members of every existing group repo, fetched (bounded) and reconciled so
  // the "no group" list is accurate on load: the union of founders (known from
  // the repo name) plus each repo's collaborators means a teammate on a
  // formed-but-unsubmitted group isn't also listed as "no group" (#245). The
  // fetch is throttled and shares the collaborators cache with the rows/modal.
  const { logins: groupRepoMembers, isPending: groupMembersPending } =
    useGroupRepoMemberLogins(org ?? "", groupRepoList)
  const groupRepoFounders = useMemo(
    () =>
      new Set([
        ...groupRepoList.map((repo) => repo.owner),
        ...groupRepoMembers,
      ]),
    [groupRepoList, groupRepoMembers],
  )

  // Roster students with no submission. "Credited" = login appears in any row's
  // `usernames` (member_usernames for groups, else [owner]), so group teammates
  // aren't falsely flagged. For groups, uncredited students surface as
  // "No group · not submitted" (see #174) — a student who never joined a
  // submitting group has no repo, so the row makes the omission explicit
  // instead of vanishing. A member of an existing group repo (its founder, or
  // any cached collaborator) is excluded here — they already appear as that
  // group's row (#245), so listing them as "no group" too would double-count
  // them. Gated on scores having loaded — until then scoresInfo is empty and
  // would flag the whole roster.
  // Hold the "not submitted" list until every source that can still reclassify
  // a student settles (snapshot, group-member reconciliation) — else a submitter
  // flashes "not submitted" before its row resolves.
  const scoresLoaded = scoresData !== undefined
  // Empty rows before the snapshot+roster land mean "loading", not "empty" —
  // gate the empty state on this so it doesn't flash on first paint. A
  // background refetch keeps scoresLoaded true, so Refresh never blanks the table.
  const initialLoading = !scoresLoaded || rosterLoading
  const nonSubmittersReady =
    scoresLoaded && !livePending && !groupMembersPending
  const nonSubmitters = useMemo(() => {
    if (!nonSubmittersReady) return []
    return reconcileNonSubmitters(students, scoresInfo, groupRepoFounders)
  }, [nonSubmittersReady, scoresInfo, students, groupRepoFounders])

  // Dashboard controls — all client-side over already-loaded data.
  // Drives the "Regrade all" confirmation modal (replaces window.confirm).
  const [regradeConfirmOpen, setRegradeConfirmOpen] = useState(false)

  // Whether a search/filter is narrowing the set — drives the table's
  // "filters hide everything" vs "nothing collected yet" empty state, and its
  // Clear-filters escape hatch.
  const hasActiveFilter =
    query.trim() !== "" ||
    filters.submission !== "all" ||
    filters.passing !== "all" ||
    filters.accepted !== "all" ||
    filters.section !== "all"
  const clearFilters = () => {
    setQuery("")
    setFilters({ ...DEFAULT_FILTERS })
  }

  // Deterministic acceptance from the org repo list (see acceptedUsernames);
  // individual assignments only, so gated on acceptedAvailable.
  const acceptedSet = useMemo(
    () =>
      acceptedUsernames(orgRepos, classroom ?? "", assignment ?? "", students),
    [orgRepos, classroom, assignment, students],
  )
  const acceptedAvailable = !isGroupAssignment && orgRepos != null

  // Group repos that exist but have no submission yet: for group assignments the
  // repo is named after the founder (not each member), so acceptance can't be
  // derived per student — instead surface every group repo from the org list
  // (#245) so teachers can see teams that formed before anyone pushes. Submitted
  // groups already show as score rows, so drop them here.
  const submittedGroupOwners = useMemo(
    () => new Set(scoresInfo.map((row) => row.owner.toLowerCase())),
    [scoresInfo],
  )
  const unsubmittedGroupRepos = useMemo(
    () => groupRepoList.filter((repo) => !submittedGroupOwners.has(repo.owner)),
    [groupRepoList, submittedGroupOwners],
  )

  // With a section filter active, scope roster and rows to it so the stat cards
  // describe the filtered view, not the whole class.
  const sectionFilter = filters.section
  const scopedStudents = useMemo(
    () =>
      sectionFilter === "all"
        ? students
        : students.filter((s) => studentInSection(s, sectionFilter)),
    [students, sectionFilter],
  )
  const scopedScores = useMemo(
    () =>
      sectionFilter === "all"
        ? scoresInfo
        : scoresInfo.filter((row) =>
            rowInSection(row, sectionFilter, sectionByUsername),
          ),
    [scoresInfo, sectionFilter, sectionByUsername],
  )
  const scopedNonSubmitters = useMemo(
    () =>
      sectionFilter === "all"
        ? nonSubmitters
        : nonSubmitters.filter((s) => studentInSection(s, sectionFilter)),
    [nonSubmitters, sectionFilter],
  )

  // Passing bar as a fraction of max, or null when the teacher didn't opt in
  // (off by default) — then no Passing rollup/filter, neutral badges.
  const passThresholdPct = assignmentInfo?.pass_threshold
  const passingEnabled =
    typeof passThresholdPct === "number" && Number.isFinite(passThresholdPct)
  const thresholdFraction = passingEnabled ? passThresholdPct / 100 : null

  // Top-line counts over the (section-scoped) submitted set + roster size.
  const stats = useMemo(
    () => computeStats(scopedScores, scopedStudents.length, thresholdFraction),
    [scopedScores, scopedStudents, thresholdFraction],
  )

  // Class average over numeric scores in the section-scoped set; null -> "N/A".
  const avgScore = useMemo(() => classAverage(scopedScores), [scopedScores])

  // Accepted count scoped to the active section (matches the card's denominator).
  const acceptedCount = useMemo(
    () => acceptedRosterCount(scopedStudents, acceptedSet),
    [scopedStudents, acceptedSet],
  )

  // Roster students who accepted (repo exists) but have no submission row.
  // Individual assignments only.
  const acceptedNotSubmittedCount = acceptedAvailable
    ? scopedNonSubmitters.filter((s) => hasAccepted(s.username, acceptedSet))
        .length
    : 0

  // One-click stat shortcuts: jump to the students a sub-label calls out. Reset
  // the other axes so the surfaced set matches the label exactly.
  const showFailing = () =>
    setFilters({ ...DEFAULT_FILTERS, passing: "failing" })
  // On this page a "not submitted" row implies the student accepted (no repo
  // ⇒ nothing to submit), so the accepted-not-submitted set is just the
  // not-submitted filter — a single axis the Status select represents exactly,
  // so switching away from it never silently drops a hidden acceptance filter.
  const showAcceptedNotSubmitted = () =>
    setFilters({ ...DEFAULT_FILTERS, submission: "not-submitted" })

  // Rows actually rendered. When acceptance data isn't loaded, neutralize the
  // accepted axis so a transient empty repo list can't flip the visible set.
  // Built on effectiveStatusFilters so live mode's pinned (hidden) status/
  // passing/accepted axes are already applied.
  const effectiveFilters = useMemo(
    () =>
      acceptedAvailable
        ? effectiveStatusFilters
        : { ...effectiveStatusFilters, accepted: "all" as const },
    [acceptedAvailable, effectiveStatusFilters],
  )
  const visibleRows = useMemo(
    () =>
      filterAndSortRows(scoresInfo, {
        query,
        filters: effectiveFilters,
        sort: effectiveSort,
        students,
        sectionByUsername,
        thresholdFraction,
      }),
    [
      scoresInfo,
      query,
      effectiveFilters,
      effectiveSort,
      students,
      sectionByUsername,
      thresholdFraction,
    ],
  )
  const visibleNonSubmitters = useMemo(
    () =>
      showsNonSubmitters(effectiveFilters)
        ? filterNonSubmitters(
            nonSubmitters,
            query,
            effectiveFilters,
            acceptedSet,
          )
        : [],
    [effectiveFilters, nonSubmitters, query, acceptedSet],
  )

  // Group repos without a submission, gated like non-submitters (hidden while a
  // narrowing filter other than "not submitted" is active) and matched against
  // the search by founder login or roster name. Section isn't filtered — a group
  // repo carries no single section.
  const visibleGroupRepos = useMemo(() => {
    if (!showsNonSubmitters(effectiveFilters)) return []
    const q = query.trim().toLowerCase()
    if (!q) return unsubmittedGroupRepos
    return unsubmittedGroupRepos.filter((repo) => {
      if (repo.owner.includes(q)) return true
      const name = getName(repo.owner, students).toLowerCase()
      return name.length > 0 && name.includes(q)
    })
  }, [effectiveFilters, query, unsubmittedGroupRepos, students])

  const collectScores = useTriggerScoreCollection(org)
  const regradeAll = useTriggerRegrade({ org, classroom, assignment })
  // `anyRegrading` covers the whole-assignment regrade AND every per-row
  // regrade (via the page coordinator), so collect/regrade controls disable
  // while any regrade is in flight.
  const regrading = regradeAll.anyRegrading
  // Whether "Regrade all" specifically is mid-dispatch, for its own
  // spinner/label (distinct from the page-wide `regrading` gate).
  const regradeAllActive =
    regradeAll.phase === "dispatching" || regradeAll.phase === "running"
  const { data: lastRun, refetch: refetchLastRun } =
    useGetLastCollectScoresRun(org)
  const collectWorkflowUrl = `https://github.com/${org}/${CONFIG_REPO}/actions/workflows/${COLLECT_SCORES_WORKFLOW}`
  const regradeWorkflowUrl = `https://github.com/${org}/${CONFIG_REPO}/actions/workflows/${REGRADE_WORKFLOW}`
  const collecting =
    collectScores.phase === "dispatching" || collectScores.phase === "running"

  // Which action the single "View …" link points at and which status strip (if
  // any) shows. Running takes precedence; else most recently finished; else
  // null. Derived fresh every render so the link never gets stuck on a stale
  // action.
  const activeAction = selectActiveWorkflowAction(
    { running: collecting, idle: collectScores.phase === "idle" },
    { running: regrading, idle: regradeAll.phase === "idle" },
  )

  const isRegradeView = activeAction === "regrade"
  const viewRun = isRegradeView ? regradeAll.run : collectScores.run
  const viewWorkflowUrl = isRegradeView
    ? regradeWorkflowUrl
    : collectWorkflowUrl
  const viewLabel = isRegradeView
    ? viewRun
      ? t("submissions.actions.viewRegradeRun")
      : t("submissions.actions.viewRegradeWorkflow")
    : viewRun
      ? t("submissions.actions.viewRun")
      : t("submissions.actions.viewWorkflow")

  const lastCollectedLabel =
    lastRun?.status === "completed" && lastRun.created_at
      ? formatRelativeToNow(new Date(lastRun.created_at))
      : null

  // Staleness heuristic (no extra API call): the most recent push across this
  // assignment's repos, read from the already-loaded org repo list's pushed_at.
  // If it's newer than the last completed collect run, scores.json probably
  // misses the newest work, so DataFreshness flags it and offers a re-collect.
  const latestPush = useMemo(
    () =>
      latestAssignmentPush(
        orgRepos,
        classroom ?? "",
        assignment ?? "",
        siblingSlugs,
      ),
    [orgRepos, classroom, assignment, siblingSlugs],
  )
  const snapshotStale =
    !isEmptyRepoAssignment &&
    snapshotIsStale(
      latestPush,
      lastRun?.status === "completed" ? lastRun.created_at : null,
    )

  // Refresh scores + last-run timestamp + org repo list once a manual collection
  // finishes, so the freshness line re-derives (the collect just consumed the
  // pushes latestPush was flagging).
  useEffect(() => {
    if (collectScores.phase === "completed") {
      refetchScores()
      refetchLastRun()
      refetchOrgRepos()
    }
  }, [collectScores.phase, refetchScores, refetchLastRun, refetchOrgRepos])

  const downloadScoresCsv = () => {
    // Group grades are per-repo (keyed by the founder/owner), so a per-teammate
    // "score 0" row is meaningless — and worse, on a degraded collect that
    // credited only the owner, a submitting teammate would be exported as 0,
    // clobbering their real group grade. So the CSV covers group non-submitters
    // via their group's row, not as individual score-0 rows (restoring the
    // pre-#174 export). Individual non-submitters (accepted-no-push or
    // never-accepted) are still legitimately 0 and stay in the export.
    const csvNonSubmitters = isGroupAssignment ? [] : nonSubmitters
    // Export the authoritative snapshot, not the live-merged view: `scoresInfo`
    // carries live count bumps only for the current page's owners, which would
    // make the file's counts depend on the last-viewed page. `snapshotScoped`
    // (the roster-scoped snapshot, already memoized for the fan-out spine) always
    // matches scores.json regardless of paging.
    const rows = buildScoresCsvRows(snapshotScoped, csvNonSubmitters)

    const csv = Papa.unparse(rows, {
      header: true,
    })

    const blob = new Blob([csv], {
      type: "text/csv;charset=utf-8;",
    })

    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")

    link.href = url
    link.download = `${classroom}-${assignment}-scores.csv`
    link.click()

    URL.revokeObjectURL(url)
  }

  if (!org || !classroom || !assignment) {
    return <MissingParams message={t("submissions.missingParams")} />
  }

  return (
    <PageShell selected="assignments">
      <Breadcrumb endpoint={t("nav.submissions")} />
      {emptyRoster.show && (
        <EmptyRosterNotice
          org={org}
          classroom={classroom}
          hasRosterRows={emptyRoster.hasRosterRows}
        />
      )}
      {rosterError && (
        <QueryErrorAlert
          message={
            <>
              {t("submissions.errors.rosterLoad")}{" "}
              {t("submissions.errors.rosterLoadHint")}
            </>
          }
          onRetry={() => refetchRoster()}
        />
      )}
      {scoresError && (
        <QueryErrorAlert
          message={
            <>
              {scoresErrorObj instanceof Error
                ? t("submissions.errors.gradebookLoadWithReason", {
                    reason: scoresErrorObj.message,
                  })
                : t("submissions.errors.gradebookLoad")}{" "}
              {t("submissions.errors.gradebookLoadHint")}
            </>
          }
          onRetry={() => refetchScores()}
        />
      )}
      <PageHeader
        title={assignmentInfo?.name}
        subtitle={
          <div className="flex flex-wrap items-center gap-2">
            {dueDate ? (
              <>
                <Badge
                  tone={dueOverdue ? "error" : "info"}
                  size="md"
                  title={formatDueDateTime(dueDate)}
                >
                  {t("submissions.dueDate", {
                    date: formatDueDateTime(dueDate),
                  })}
                </Badge>
                {dueRelative && (
                  <Badge tone={dueOverdue ? "error" : "warning"} size="md">
                    {dueRelative}
                  </Badge>
                )}
              </>
            ) : (
              <span>{t("submissions.noDueDate")}</span>
            )}
            {lateCount > 0 && (
              <Badge tone="error" size="sm">
                {t("submissions.lateBadge", { count: lateCount })}
              </Badge>
            )}
            {assignmentInfo?.template && (
              <GitHubLink
                href={githubTemplateRepoUrl(
                  assignmentInfo.template.owner,
                  assignmentInfo.template.repo,
                  assignmentInfo.template.branch,
                )}
                label={t("submissions.viewSourceRepo")}
                title={`${assignmentInfo.template.owner}/${assignmentInfo.template.repo}`}
              />
            )}
          </div>
        }
      />

      {/* Live status strip. Full phase mapping: dispatching stays a quiet
          neutral line (transient); running/completed/failed/timeout become an
          Alert; idle renders nothing. */}
      {activeAction === "collect" && collectScores.phase !== "idle" && (
        <>
          {collectScores.phase === "dispatching" && (
            <p className="text-sm text-base-content/70" role="status">
              {t("submissions.collect.statusDispatching")}
            </p>
          )}
          {collectScores.phase === "running" && (
            <Alert tone="info" role="status">
              <Spinner size="xs" />
              {t("submissions.collect.statusRunning")}
            </Alert>
          )}
          {collectScores.phase === "completed" && (
            <Alert tone="success" role="status">
              {t("submissions.collect.statusCompleted")}
            </Alert>
          )}
          {collectScores.phase === "failed" && (
            <Alert tone="error" role="status">
              {collectScores.error instanceof Error
                ? t("submissions.collect.statusFailedWithReason", {
                    reason: collectScores.error.message,
                  })
                : t("submissions.collect.statusFailed")}{" "}
              {t("submissions.collect.statusFailedHint")}
            </Alert>
          )}
          {collectScores.phase === "timeout" && (
            <Alert tone="warning" role="status">
              {t("submissions.collect.statusTimeout")}
            </Alert>
          )}
        </>
      )}
      {activeAction === "regrade" && regradeAll.phase !== "idle" && (
        <>
          {regradeAll.phase === "dispatching" && (
            <p className="text-sm text-base-content/70" role="status">
              {t("submissions.regradeAll.statusDispatching")}
            </p>
          )}
          {regradeAll.phase === "running" && (
            <Alert tone="info" role="status">
              <Spinner size="xs" />
              {t("submissions.regradeAll.statusRunning")}
            </Alert>
          )}
          {regradeAll.phase === "completed" && (
            <Alert tone="success" role="status">
              <Trans
                i18nKey="submissions.regradeAll.statusCompleted"
                values={{ collectLabel: t("submissions.collect.label") }}
                components={{
                  collectLabel: <span className="font-semibold" />,
                }}
              />
            </Alert>
          )}
          {regradeAll.phase === "failed" && (
            <Alert tone="error" role="status">
              {regradeAll.error instanceof Error
                ? t("submissions.regradeAll.statusFailedWithReason", {
                    reason: regradeAll.error.message,
                  })
                : t("submissions.regradeAll.statusFailed")}{" "}
              {t("submissions.regradeAll.statusFailedHint")}
            </Alert>
          )}
          {regradeAll.phase === "timeout" && (
            <Alert tone="warning" role="status">
              {t("submissions.regradeAll.statusTimeout")}
            </Alert>
          )}
        </>
      )}
      <SubmissionsControls
        query={query}
        onQueryChange={setQuery}
        filters={filters}
        onFiltersChange={setFilters}
        sort={sort}
        onSortChange={setSort}
        isGroup={isGroupAssignment}
        acceptedAvailable={acceptedAvailable}
        passingAvailable={passingEnabled}
        sections={sections}
        // Live shows a page-scoped fan-out that can only align to the plain
        // name-ordered, unfiltered view, so hide Sort + Status while live.
        hideSortAndStatus={liveCapable}
        onShare={() => setAcceptOpen(true)}
        leading={
          <DataFreshness
            lastCollectedLabel={lastCollectedLabel}
            stale={snapshotStale}
            collecting={collecting}
            errorCount={liveErrorCount}
            emptyRepo={isEmptyRepoAssignment}
            onRefresh={
              collecting || emptyRoster.show
                ? undefined
                : () => {
                    // Sync = re-collect (rebuild scores.json). Re-read the org
                    // repo list too so the staleness line re-derives against the
                    // newest pushes (latestPush would otherwise stay frozen at
                    // page load), and re-run the live fan-out for a live-capable
                    // viewer so presence refreshes alongside the dispatched
                    // collect.
                    collectScores.collect()
                    refetchOrgRepos()
                    if (liveCapable) refetchLive()
                  }
            }
          />
        }
        trailing={
          <SubmissionsActionsMenu
            collecting={collecting}
            regrading={regrading}
            regradeAllActive={regradeAllActive}
            canRegradeAll={canRegradeAll}
            emptyRoster={emptyRoster.show}
            emptyRepo={isEmptyRepoAssignment}
            // Metrics summarizes the graded snapshot; hide it when live (the
            // overlay adds ungraded pending rows the stats don't model).
            onMetrics={liveCapable ? undefined : () => setMetricsOpen(true)}
            onCollect={() => collectScores.collect()}
            onRegradeAll={() => setRegradeConfirmOpen(true)}
            viewHref={viewRun?.html_url || viewWorkflowUrl}
            viewLabel={viewLabel}
            onDownloadCsv={downloadScoresCsv}
            downloadDisabled={!scoresInfo.length && !nonSubmitters.length}
          />
        }
      />
      <SubmissionsTable
        scores={visibleRows}
        students={students}
        nonSubmitters={visibleNonSubmitters}
        unsubmittedGroupRepos={visibleGroupRepos}
        isGroup={isGroupAssignment}
        org={org}
        classroom={classroom}
        assignment={assignment}
        assignmentName={assignmentInfo?.name}
        maxGroupSize={assignmentInfo?.max_group_size}
        acceptedUsernames={acceptedAvailable ? acceptedSet : undefined}
        thresholdFraction={thresholdFraction}
        filtered={hasActiveFilter}
        onClearFilters={clearFilters}
        emptyRepo={isEmptyRepoAssignment}
        initialLoading={initialLoading}
        nonSubmittersLoading={
          !nonSubmittersReady &&
          students.length > 0 &&
          showsNonSubmitters(effectiveFilters)
        }
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        sort={effectiveSort}
      />
      <ConfirmModal
        open={regradeConfirmOpen}
        title={t("submissions.regradeAll.confirmTitle", {
          name: assignmentInfo?.name ?? assignment,
        })}
        description={
          <>
            {t("submissions.regradeAll.confirmBody1")}
            <br />
            <br />
            <Trans
              i18nKey="submissions.regradeAll.confirmBody2"
              values={{ collectLabel: t("submissions.collect.label") }}
              components={{
                collectLabel: <span className="font-semibold" />,
              }}
            />
          </>
        }
        confirmText="regrade"
        confirmLabel={t("submissions.regradeAll.label")}
        cancelLabel={t("common.cancel")}
        dangerous={false}
        needsConfirm={false}
        onConfirm={async () => {
          regradeAll.regrade()
        }}
        onClose={() => setRegradeConfirmOpen(false)}
      />
      <MetricsModal
        open={metricsOpen && !liveCapable}
        onClose={() => setMetricsOpen(false)}
        isGroup={isGroupAssignment}
        submitted={stats.submitted}
        rosterCount={scopedStudents.length}
        avgScore={avgScore}
        maxScore={scopedScores?.[0]?.["max-score"]}
        notAvailableLabel={t("submissions.stats.notAvailable")}
        passing={stats.passing}
        passingEnabled={passingEnabled}
        passingDenom={stats.passing + stats.failing}
        failing={stats.failing}
        ungraded={stats.ungraded}
        onShowFailing={showFailing}
        acceptedAvailable={acceptedAvailable}
        acceptedCount={acceptedCount}
        acceptedNotSubmitted={acceptedNotSubmittedCount}
        onShowAcceptedNotSubmitted={showAcceptedNotSubmitted}
      />
      <AcceptLinkModal
        open={acceptOpen}
        onClose={() => setAcceptOpen(false)}
        url={assignmentSubmitUrl}
        cli={assignmentSubmitCli}
        hasSecret={Boolean(secret)}
      />
    </PageShell>
  )
}

// The teacher gradebook. Students who land here directly (e.g. an old link) are
// redirected to their own submission view; we wait for the role to resolve so a
// real teacher never bounces, and avoid firing teacher-only reads for a student.
const SubmissionsPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.submissions"))
  const { org, classroom, assignment } = useParams({ strict: false })
  const { role, roleResolved } = useClassroomRoleContext()

  if (!roleResolved) {
    return <RoleResolvingFallback className="min-h-screen" />
  }

  if (
    !can("viewClassroomStaffContent", { classroomRole: role }) &&
    org &&
    classroom &&
    assignment
  ) {
    return (
      <Navigate
        to="/$org/$classroom/assignments/$assignment/submission"
        params={{ org, classroom, assignment }}
        replace
      />
    )
  }

  return (
    <RegradeCoordinatorProvider>
      <SubmissionsPageContent />
    </RegradeCoordinatorProvider>
  )
}

export default SubmissionsPage
