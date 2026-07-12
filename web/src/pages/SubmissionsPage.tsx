import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import Papa from "papaparse"

import { BarChart3, Info, LinkIcon, RefreshCw } from "lucide-react"
import { useParams, Navigate } from "@tanstack/react-router"

import Breadcrumb from "@/components/breadcrumb"
import PageHeader from "@/components/PageHeader"
import PageShell from "@/components/PageShell"
import MissingParams from "@/components/MissingParams"
import { Alert, Badge, Button, Spinner } from "@/components/ui"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import SubmissionsTable from "@/pages/submissions/SubmissionsTable"
import SubmissionsControls from "@/pages/submissions/SubmissionsControls"
import { SubmissionsActionsMenu } from "@/pages/submissions/SubmissionsActionsMenu"
import { AcceptLinkModal } from "@/pages/submissions/AcceptLinkModal"
import { MetricsModal } from "@/pages/submissions/MetricsModal"
import { ConfirmModal } from "@/components/modals"
import {
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  acceptedRosterCount,
  acceptedUsernames,
  buildScoresCsvRows,
  buildSectionLookup,
  classAverage,
  computeStats,
  distinctSections,
  filterAndSortRows,
  filterNonSubmitters,
  hasAccepted,
  rosterScopedRows,
  rowInSection,
  selectActiveWorkflowAction,
  showsNonSubmitters,
  studentInSection,
  type SubmissionFilters,
  type SubmissionSort,
} from "@/pages/submissions/dashboard"
import useGetScores from "@/hooks/useGetScores"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import useGetClassroom from "@/hooks/useGetClassroom"
import useGetStudents from "@/hooks/useGetStudents"
import { useTeamRoster } from "@/hooks/useTeamRoster"
import { rowToStudent } from "@/util/teamRoster"
import { hasStudentEnrollment } from "@/util/rosterRoles"
import type { Student } from "@/types/classroom"
import useEmptyRosterWarning from "@/hooks/useEmptyRosterWarning"
import { EmptyRosterNotice } from "@/components/EmptyRosterNotice"
import { QueryErrorAlert } from "@/components/QueryErrorAlert"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import useTriggerScoreCollection from "@/hooks/useTriggerScoreCollection"
import useTriggerRegrade from "@/hooks/useTriggerRegrade"
import { RegradeCoordinatorProvider } from "@/context/regrade/RegradeCoordinator"
import useGetLastCollectScoresRun from "@/hooks/useGetLastCollectScoresRun"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import RoleResolvingFallback from "@/components/RoleResolvingFallback"
import {
  COLLECT_SCORES_WORKFLOW,
  REGRADE_WORKFLOW,
} from "@/hooks/github/mutations"
import {
  formatDueDateTime,
  formatRelativeToNow,
  isPastDue,
  dueDeadlineInstant,
} from "@/util/formatDate"
import { githubTemplateRepoUrl } from "@/util/orgUrl"
import { GitHubLink } from "@/components/GitHubLink"

// Re-renders so a relative "updated X ago" label stays live, at a cadence that
// matches the elapsed magnitude: every second under a minute, every minute
// under an hour, every hour beyond. Purely a UI refresh — no data fetching; it
// returns the tick time so callers derive recency from it rather than calling
// Date.now() during render (which the React Compiler flags as impure).
export const cadenceForElapsed = (elapsedMs: number): number => {
  if (elapsedMs < 60_000) return 1_000
  if (elapsedMs < 3_600_000) return 60_000
  return 3_600_000
}

const useLiveNow = (referenceMs: number | null) => {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // No reference yet (data not loaded) — a slow 1-min heartbeat is enough to
    // keep any other relative labels fresh without a per-second loop.
    const intervalMs =
      referenceMs && referenceMs > 0
        ? cadenceForElapsed(Date.now() - referenceMs)
        : 60_000
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
    // Re-arm when the reference changes (a refetch resets it to ~now, dropping
    // back to the 1s cadence) and when `now` crosses a threshold (the elapsed
    // magnitude — and thus the cadence — steps up).
  }, [referenceMs, now])

  return now
}

const SubmissionsPageContent = () => {
  const { t } = useTranslation()
  const { org, classroom, assignment } = useParams({ strict: false })
  const {
    data: scoresData,
    refetch: refetchScores,
    isFetching: scoresFetching,
    isError: scoresError,
    error: scoresErrorObj,
    dataUpdatedAt: scoresUpdatedAt,
  } = useGetScores(org, classroom)
  // Live clock for the "Updated …" label, ticking faster the more recent the
  // last fetch (1s < 1min < 1hr). UI-only; the fetch cadence is unchanged.
  const now = useLiveNow(scoresUpdatedAt || null)
  const { data: assignmentData } = useGetClassroomAssignments(org, classroom)
  // Team-driven usernames (Section 7): the classroom GitHub team is
  // authoritative for enrollment; roster.csv enriches display only. The
  // dashboard consumes Student[], so map enrolled team rows into that shape.
  // Restrict to rows carrying a STUDENT enrollment — a pure instructor/TA is an
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
      teamRows
        .filter((r) => r.state === "enrolled" && hasStudentEnrollment(r))
        .map(rowToStudent),
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
  // "Updated" recency label. A just-settled fetch is ~0s old, and
  // formatRelativeToNow would render that as the awkward "0 seconds ago" that
  // then lingers between ticks — show "just now" under a short threshold
  // instead. The periodic rerender (below) advances it as time passes.
  const scoresUpdatedSecondsAgo =
    scoresUpdatedAt > 0 ? (now - scoresUpdatedAt) / 1000 : null
  const scoresLastUpdated =
    scoresUpdatedSecondsAgo === null
      ? t("submissions.dashboard.never")
      : scoresUpdatedSecondsAgo < 10
        ? t("submissions.justNow")
        : formatRelativeToNow(scoresUpdatedAt)

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
  // Scope the collector's scores to the CURRENT roster (see rosterScopedRows).
  // Gate on a resolved roster so a transient load/permission failure falls back
  // to unscoped rows rather than blanking a populated gradebook.
  const rosterReady = !rosterLoading && !rosterError
  const scoresInfo = useMemo(() => {
    const rows = scoresData?.submissions?.[assignment ?? ""] || []
    return rosterReady ? rosterScopedRows(rows, students) : rows
  }, [scoresData, assignment, rosterReady, students])

  // Repos whose latest submission landed after the deadline. `late` is computed
  // upstream (collect_scores.py) from push time, not grade time.
  const lateCount = scoresInfo.filter((row) => row.late).length

  // Due-date presentation: absolute date + a relative countdown ("in 3 days" /
  // "2 hours ago"). Past due flips the badge to error and the label to overdue.
  const dueDate = assignmentInfo?.due
  const dueOverdue = dueDate ? isPastDue(dueDate) : false
  const dueRelative = dueDate
    ? formatRelativeToNow(dueDeadlineInstant(dueDate) ?? new Date(dueDate))
    : null

  // Roster students with no submission. "Credited" = login appears in any row's
  // `usernames` (member_usernames for groups, else [owner]), so group teammates
  // aren't falsely flagged. For groups, uncredited students surface as
  // "No group · not submitted" (see #174) — a student who never joined a
  // submitting group has no repo, so the row makes the omission explicit
  // instead of vanishing. Gated on scores having loaded — until then scoresInfo
  // is empty and would flag the whole roster.
  const scoresLoaded = scoresData !== undefined
  const nonSubmitters = useMemo(() => {
    if (!scoresLoaded) return []
    const credited = new Set(
      scoresInfo.flatMap((row) => row.usernames.map((u) => u.toLowerCase())),
    )
    return students.filter(
      (student) => !credited.has(student.username.toLowerCase()),
    )
  }, [scoresLoaded, scoresInfo, students])

  // Dashboard controls — all client-side over already-loaded data.
  const [query, setQuery] = useState("")
  const [filters, setFilters] = useState<SubmissionFilters>(DEFAULT_FILTERS)
  // Drives the "Regrade all" confirmation modal (replaces window.confirm).
  const [regradeConfirmOpen, setRegradeConfirmOpen] = useState(false)
  const [sort, setSort] = useState<SubmissionSort>(DEFAULT_SORT)

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
  const { data: orgRepos } = useGetOrgRepos(org ?? "")
  const acceptedSet = useMemo(
    () =>
      acceptedUsernames(orgRepos, classroom ?? "", assignment ?? "", students),
    [orgRepos, classroom, assignment, students],
  )
  const acceptedAvailable = !isGroupAssignment && orgRepos != null

  // Section filtering: distinct sections for the dropdown, plus a username ->
  // section lookup so submitted rows (which carry only logins) can be matched.
  const sections = useMemo(() => distinctSections(students), [students])
  const sectionByUsername = useMemo(
    () => buildSectionLookup(students),
    [students],
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
  const effectiveFilters = useMemo(
    () =>
      acceptedAvailable ? filters : { ...filters, accepted: "all" as const },
    [acceptedAvailable, filters],
  )
  const visibleRows = useMemo(
    () =>
      filterAndSortRows(scoresInfo, {
        query,
        filters: effectiveFilters,
        sort,
        students,
        sectionByUsername,
        thresholdFraction,
      }),
    [
      scoresInfo,
      query,
      effectiveFilters,
      sort,
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
  const collectWorkflowUrl = `https://github.com/${org}/classroom50/actions/workflows/${COLLECT_SCORES_WORKFLOW}`
  const regradeWorkflowUrl = `https://github.com/${org}/classroom50/actions/workflows/${REGRADE_WORKFLOW}`
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

  // Refresh scores + last-run timestamp once a manual collection finishes.
  useEffect(() => {
    if (collectScores.phase === "completed") {
      refetchScores()
      refetchLastRun()
    }
  }, [collectScores.phase, refetchScores, refetchLastRun])

  const downloadScoresCsv = () => {
    // Group grades are per-repo (keyed by the founder/owner), so a per-teammate
    // "score 0" row is meaningless — and worse, on a degraded collect that
    // credited only the owner, a submitting teammate would be exported as 0,
    // clobbering their real group grade. So the CSV covers group non-submitters
    // via their group's row, not as individual score-0 rows (restoring the
    // pre-#174 export). Individual non-submitters (accepted-no-push or
    // never-accepted) are still legitimately 0 and stay in the export.
    const csvNonSubmitters = isGroupAssignment ? [] : nonSubmitters
    const rows = buildScoresCsvRows(scoresInfo, csvNonSubmitters)

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
            <span className="inline-flex items-center gap-1 text-base-content/70">
              {t("submissions.updated", { when: scoresLastUpdated })}
              <Button
                variant="ghost"
                size="xs"
                shape="circle"
                disabled={scoresFetching}
                onClick={() => refetchScores()}
                aria-label={t("submissions.refresh")}
                title={t("submissions.refresh")}
              >
                <RefreshCw
                  aria-hidden="true"
                  size={12}
                  className={scoresFetching ? "animate-spin" : ""}
                />
              </Button>
            </span>
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
      {/* Thin collection note with last-collected recency. Actions moved into
          the toolbar menu below so the roster surfaces near the top. */}
      <div className="flex items-start gap-2 text-sm text-base-content/70">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p>
          {t("submissions.collectionNote")}{" "}
          {lastCollectedLabel && (
            <span>
              {t("submissions.lastCollected", { when: lastCollectedLabel })}
            </span>
          )}
        </p>
      </div>

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
              {t("submissions.regradeAll.statusCompleted_prefix")}{" "}
              <span className="font-semibold">
                {t("submissions.collect.label")}
              </span>{" "}
              {t("submissions.regradeAll.statusCompleted_suffix")}
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
        trailing={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMetricsOpen(true)}
              title={t("submissions.metrics.title")}
            >
              <BarChart3 aria-hidden="true" className="size-4" />
              {t("submissions.menu.metrics")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAcceptOpen(true)}
              title={t("submissions.accept.heading")}
            >
              <LinkIcon aria-hidden="true" className="size-4" />
              {t("submissions.menu.invite")}
            </Button>
            <SubmissionsActionsMenu
              collecting={collecting}
              regrading={regrading}
              regradeAllActive={regradeAllActive}
              emptyRoster={emptyRoster.show}
              onCollect={() => collectScores.collect()}
              onRegradeAll={() => setRegradeConfirmOpen(true)}
              viewHref={viewRun?.html_url || viewWorkflowUrl}
              viewLabel={viewLabel}
              onDownloadCsv={downloadScoresCsv}
              downloadDisabled={!scoresInfo.length && !nonSubmitters.length}
            />
          </>
        }
      />
      <SubmissionsTable
        scores={visibleRows}
        students={students}
        nonSubmitters={visibleNonSubmitters}
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
            {t("submissions.regradeAll.confirmBody2_prefix")}{" "}
            <span className="font-semibold">
              {t("submissions.collect.label")}
            </span>{" "}
            {t("submissions.regradeAll.confirmBody2_suffix")}
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
        open={metricsOpen}
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
  const { showTeacherUi, roleResolved } = useClassroomRoleContext()

  if (!roleResolved) {
    return <RoleResolvingFallback className="min-h-screen" />
  }

  if (!showTeacherUi && org && classroom && assignment) {
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
