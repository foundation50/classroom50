import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import Papa from "papaparse"

import {
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  HardDriveDownload,
  Info,
  LinkIcon,
  RefreshCw,
} from "lucide-react"
import { useParams, Navigate } from "@tanstack/react-router"

import Breadcrumb from "@/components/breadcrumb"
import MissingParams from "@/components/MissingParams"
import Drawer, {
  DrawerContent,
  DrawerSidebar,
  DrawerToggle,
} from "@/components/drawer"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import SubmissionsTable from "@/pages/submissions/SubmissionsTable"
import SubmissionsControls from "@/pages/submissions/SubmissionsControls"
import { ConfirmModal } from "@/components/modals"
import {
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  acceptedRosterCount,
  acceptedUsernames,
  buildSectionLookup,
  classAverage,
  computeStats,
  distinctSections,
  filterAndSortRows,
  filterNonSubmitters,
  hasAccepted,
  rowInSection,
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
import type { Student } from "@/types/classroom"
import useEmptyRosterWarning from "@/hooks/useEmptyRosterWarning"
import { EmptyRosterNotice } from "@/components/EmptyRosterNotice"
import { QueryErrorAlert } from "@/components/QueryErrorAlert"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import useTriggerScoreCollection from "@/hooks/useTriggerScoreCollection"
import useTriggerRegrade from "@/hooks/useTriggerRegrade"
import { RegradeCoordinatorProvider } from "@/context/regrade/RegradeCoordinator"
import useGetLastCollectScoresRun from "@/hooks/useGetLastCollectScoresRun"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { useCourseTeacherAccess } from "@/hooks/useCourseTeacherAccess"
import RoleResolvingFallback from "@/components/RoleResolvingFallback"
import {
  COLLECT_SCORES_WORKFLOW,
  REGRADE_WORKFLOW,
} from "@/hooks/github/mutations"
import { formatDueDateTime, formatRelativeToNow } from "@/util/formatDate"

// Re-renders on an interval to keep relative timestamps fresh; returns nothing.
const usePeriodicRerender = (intervalMs = 30_000) => {
  const [, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
}

// Shared presentational copy button: a primary outline button that swaps to a
// success check while `copied`. The clipboard state itself is owned by the
// caller (via useCopyToClipboard) so each button tracks its own copy.
const CopyIconButton = ({
  copied,
  onCopy,
  label,
}: {
  copied: boolean
  onCopy: (e: React.MouseEvent<HTMLButtonElement>) => void
  label: string
}) => (
  <button
    type="button"
    className={`btn ${copied ? "btn-success" : "btn-primary"} btn-sm btn-outline mr-2`}
    onClick={onCopy}
    aria-label={label}
    title={label}
  >
    {copied ? (
      <Check aria-hidden="true" className="size-4" />
    ) : (
      <Copy aria-hidden="true" className="size-4" />
    )}
  </button>
)

// Shared chrome for the dashboard stat strip: a bordered card with an uppercase
// label. The body (value, denominator, sub-links) varies per stat and is passed
// as children.
const StatCard = ({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) => (
  <div className="card bg-base-100 rounded-xl border border-base-300">
    <div className="card-body gap-1 p-4">
      <label className="text-xs uppercase tracking-wide text-base-content/70">
        {label}
      </label>
      {children}
    </div>
  </div>
)

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
  const { data: assignmentData } = useGetClassroomAssignments(org, classroom)
  // Team-driven username source (Section 7): the classroom GitHub team is
  // authoritative for who is enrolled; students.csv is joined by
  // useTeamRoster only to enrich display (name/section/email). The dashboard
  // (non-submitters, sections, accepted, gradebook) consumes a Student[], so
  // map the enrolled team rows into that shape. Non-submitters = team members
  // minus credited usernames (below).
  const { students: csvStudents } = useGetStudents(org, classroom)
  // Surface the team-member fetch's error/loading (useTeamRoster exposes them
  // deliberately): a transient or permission failure of the enrolled source of
  // truth must render as an error+retry, not as an authoritative empty roster.
  const {
    rows: teamRows,
    isError: rosterError,
    refetch: refetchRoster,
  } = useTeamRoster(org ?? "", classroom ?? "", csvStudents)
  const students: Student[] = useMemo(
    () => teamRows.filter((r) => r.state === "enrolled").map(rowToStudent),
    [teamRows],
  )
  // Gate Regrade all / Collect now on an empty roster: dispatching a workflow
  // with no students to act on is wasted effort. `show` is loading-aware (won't
  // flash before the roster resolves), matching AssignmentsPage's usage.
  const emptyRoster = useEmptyRosterWarning(org, classroom)
  // This is a teacher-only page, so reading the classroom's capability-URL
  // secret from the (teacher-readable) classroom.json is fine. When the
  // classroom is protected, the shared accept link must carry the key as
  // `?k=<secret>` — otherwise students hit "assignment not found".
  const { data: classroomMeta } = useGetClassroom(org, classroom)
  const secret = classroomMeta?.secret
  const scoresLastUpdated =
    scoresUpdatedAt > 0
      ? formatRelativeToNow(scoresUpdatedAt)
      : t("submissions.dashboard.never")

  const assignmentSubmitUrl =
    `${window.location.origin}/${org}/${classroom}/assignments/${assignment}/accept` +
    (secret ? `?k=${secret}` : "")
  // The CLI equivalent of the browser accept link, for students who prefer it.
  const assignmentSubmitCli =
    `gh student accept ${org} ${classroom} ${assignment}` +
    (secret ? ` --key ${secret}` : "")
  const { copied: copiedSubmitLink, copy: copySubmitLink } = useCopyToClipboard(
    assignmentSubmitUrl,
    1500,
  )
  const { copied: copiedSubmitCli, copy: copySubmitCli } = useCopyToClipboard(
    assignmentSubmitCli,
    1500,
  )

  // Re-render every 30s so the relative "last collected"/"last updated" labels stay fresh.
  usePeriodicRerender()
  const assignmentInfo = assignmentData?.assignments.find(
    (a) => a.slug === assignment,
  )
  const isGroupAssignment = assignmentInfo?.mode === "group"
  const scoresInfo = useMemo(
    () => scoresData?.submissions?.[assignment ?? ""] || [],
    [scoresData, assignment],
  )

  // Count repos whose latest submission landed after the deadline. `late` is
  // computed upstream (collect_scores.py) from the push time, not the grade
  // time, so an on-time push graded after the deadline still counts as on time.
  const lateCount = scoresInfo.filter((row) => row.late).length

  // Roster students with no submission. A student is "credited" if their login
  // appears in any row's `usernames` (which is `member_usernames` for groups,
  // else `[owner]`), so group teammates aren't falsely flagged. Group
  // assignments don't surface an "X of Y" roster denominator, so we only
  // compute non-submitters for individual assignments. Gated on scores having
  // loaded (`scoresData` present): until then `scoresInfo` is empty, which
  // would otherwise flag the entire roster as non-submitters mid-load.
  const scoresLoaded = scoresData !== undefined
  const nonSubmitters = useMemo(() => {
    if (isGroupAssignment || !scoresLoaded) return []
    const credited = new Set(
      scoresInfo.flatMap((row) => row.usernames.map((u) => u.toLowerCase())),
    )
    return students.filter(
      (student) => !credited.has(student.username.toLowerCase()),
    )
  }, [isGroupAssignment, scoresLoaded, scoresInfo, students])

  // Dashboard controls — all client-side over already-loaded data.
  const [query, setQuery] = useState("")
  const [filters, setFilters] = useState<SubmissionFilters>(DEFAULT_FILTERS)
  // Drives the "Regrade all" confirmation modal (replaces window.confirm).
  const [regradeConfirmOpen, setRegradeConfirmOpen] = useState(false)
  const [sort, setSort] = useState<SubmissionSort>(DEFAULT_SORT)

  // Deterministic acceptance from the org repo list (see acceptedUsernames);
  // individual assignments only, so the filter is gated on acceptedAvailable.
  const { data: orgRepos } = useGetOrgRepos(org ?? "")
  const acceptedSet = useMemo(
    () =>
      acceptedUsernames(orgRepos, classroom ?? "", assignment ?? "", students),
    [orgRepos, classroom, assignment, students],
  )
  const acceptedAvailable = !isGroupAssignment && orgRepos != null

  // Section filtering: distinct sections for the dropdown, and a username ->
  // section lookup so submitted rows (which carry only logins) can be matched.
  const sections = useMemo(() => distinctSections(students), [students])
  const sectionByUsername = useMemo(
    () => buildSectionLookup(students),
    [students],
  )

  // With a section filter active, scope the roster and rows to that section so
  // the stat cards describe the filtered view, not the whole class.
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
  // (off by default) — then no Passing rollup/filter and neutral badges.
  const passThresholdPct = assignmentInfo?.pass_threshold
  const passingEnabled =
    typeof passThresholdPct === "number" && Number.isFinite(passThresholdPct)
  const thresholdFraction = passingEnabled ? passThresholdPct / 100 : null

  // Top-line counts over the (section-scoped) submitted set + roster size.
  const stats = useMemo(
    () => computeStats(scopedScores, scopedStudents.length, thresholdFraction),
    [scopedScores, scopedStudents, thresholdFraction],
  )

  // Class average over numeric scores in the (section-scoped) set; null -> "N/A".
  const avgScore = useMemo(() => classAverage(scopedScores), [scopedScores])

  // Roster-scoped accepted count (scoped to the active section to match the
  // Accepted card's denominator).
  const acceptedCount = useMemo(
    () => acceptedRosterCount(scopedStudents, acceptedSet),
    [scopedStudents, acceptedSet],
  )

  // Accepted-but-not-submitted count: roster students who accepted (repo
  // exists) but have no submission row. Individual assignments only.
  const acceptedNotSubmittedCount = acceptedAvailable
    ? scopedNonSubmitters.filter((s) => hasAccepted(s.username, acceptedSet))
        .length
    : 0

  // One-click stat shortcuts: jump straight to the students a sub-label calls
  // out. Reset the other axes so the surfaced set matches the label exactly.
  const showFailing = () =>
    setFilters({ ...DEFAULT_FILTERS, passing: "failing" })
  const showAcceptedNotSubmitted = () =>
    setFilters({
      ...DEFAULT_FILTERS,
      accepted: "accepted",
      submission: "not-submitted",
    })

  // Rows actually rendered. When acceptance data isn't loaded yet, neutralize
  // the accepted axis so a transient empty repo list can't flip the visible set.
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
  // regrade (shared via the page coordinator), so collect/regrade controls
  // disable while any regrade is in flight — not just the assignment-wide one.
  const regrading = regradeAll.anyRegrading
  // Whether the assignment-wide "Regrade all" specifically is mid-dispatch, for
  // its own spinner/label (distinct from the page-wide `regrading` gate).
  const regradeAllActive =
    regradeAll.phase === "dispatching" || regradeAll.phase === "running"
  const { data: lastRun, refetch: refetchLastRun } =
    useGetLastCollectScoresRun(org)
  const collectWorkflowUrl = `https://github.com/${org}/classroom50/actions/workflows/${COLLECT_SCORES_WORKFLOW}`
  const regradeWorkflowUrl = `https://github.com/${org}/classroom50/actions/workflows/${REGRADE_WORKFLOW}`
  const collecting =
    collectScores.phase === "dispatching" || collectScores.phase === "running"

  // Which action the single "View …" link points at and which status strip
  // (if any) shows. Running takes precedence; otherwise the most recently
  // finished action; else null (both idle → link defaults to collect). Derived
  // fresh every render so the link can never get "stuck" on a stale action.
  const activeAction: "collect" | "regrade" | null = (() => {
    if (collecting) return "collect"
    if (regrading) return "regrade"
    if (collectScores.phase !== "idle") return "collect"
    if (regradeAll.phase !== "idle") return "regrade"
    return null
  })()

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

  // Refresh scores and the last-run timestamp once a manual collection finishes.
  useEffect(() => {
    if (collectScores.phase === "completed") {
      refetchScores()
      refetchLastRun()
    }
  }, [collectScores.phase, refetchScores, refetchLastRun])

  const downloadScoresCsv = () => {
    const submittedRows = scoresInfo
      .toSorted(
        (a, b) =>
          new Date(b.datetime).getTime() - new Date(a.datetime).getTime(),
      )
      .map(
        ({ usernames, score, datetime, submissionCount, late, ...rest }) => ({
          usernames: usernames.join(", "),
          score,
          max_score: rest["max-score"],
          submissions: submissionCount,
          submitted_at: new Date(datetime).toISOString(),
          late: late ? "yes" : "no",
          commit: rest.commit,
          review: rest.review,
          release: rest.release,
        }),
      )

    // Append non-submitters so the exported gradebook covers the whole roster.
    // Scored 0 with blank submission fields; pinned after submitters.
    const nonSubmittedRows = nonSubmitters.map((student) => ({
      usernames: student.username,
      score: 0,
      max_score: "",
      submissions: 0,
      submitted_at: "",
      late: "",
      commit: "",
      review: "",
      release: "",
    }))

    const rows = [...submittedRows, ...nonSubmittedRows]

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
    <div className="min-h-screen">
      <Drawer>
        <DrawerToggle />
        <DrawerContent className="p-10 bg-base-200 2xl:px-50">
          <Breadcrumb endpoint={t("nav.submissions")} />
          {emptyRoster.show && (
            <EmptyRosterNotice
              org={org}
              classroom={classroom}
              hasRosterRows={emptyRoster.hasRosterRows}
              className="mt-4"
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
          <div className="flex justify-between">
            <div>
              <h1 className="text-lg pt-8 pb-2 font-bold">
                {assignmentInfo?.name}
              </h1>
              <div className="flex flex-wrap items-center gap-2 pb-10 text-sm text-base-content/70">
                <span>
                  {assignmentInfo?.due
                    ? t("submissions.dueDate", {
                        date: formatDueDateTime(assignmentInfo.due),
                      })
                    : t("submissions.noDueDate")}
                </span>
                {lateCount > 0 && (
                  <span className="badge badge-sm badge-error badge-soft">
                    {t("submissions.lateBadge", { count: lateCount })}
                  </span>
                )}
              </div>
            </div>
            <div className="pt-10">
              <button
                type="button"
                className="btn btn-outline"
                onClick={downloadScoresCsv}
                disabled={!scoresInfo.length && !nonSubmitters.length}
              >
                <HardDriveDownload aria-hidden="true" />{" "}
                {t("submissions.downloadCsv")}
              </button>
            </div>
          </div>
          <div className="mb-4 rounded-box border border-info/20 bg-info/5">
            {/* Compact action bar: standing note on the left, the two actions
                + a single contextual View link on the right. */}
            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <Info
                  aria-hidden="true"
                  className="mt-0.5 size-5 shrink-0 text-info"
                />
                <p className="text-sm text-base-content/70">
                  {t("submissions.collectionNote")}{" "}
                  {!collecting &&
                    !regrading &&
                    activeAction === null &&
                    lastCollectedLabel && (
                      <span className="text-base-content/70">
                        {t("submissions.lastCollected", {
                          when: lastCollectedLabel,
                        })}
                      </span>
                    )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  disabled={regrading || collecting || emptyRoster.show}
                  title={
                    emptyRoster.show
                      ? t("submissions.regradeAll.titleEmptyRoster")
                      : collecting
                        ? t("submissions.regradeAll.titleCollecting")
                        : regrading
                          ? t("submissions.regradeAll.titleRegrading")
                          : t("submissions.regradeAll.title")
                  }
                  onClick={() => {
                    if (regrading || collecting || emptyRoster.show) return
                    setRegradeConfirmOpen(true)
                  }}
                >
                  {regradeAllActive && (
                    <span
                      className="loading loading-spinner loading-xs"
                      aria-hidden="true"
                    />
                  )}
                  {regradeAllActive
                    ? t("submissions.regradeAll.active")
                    : t("submissions.regradeAll.label")}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={collecting || regrading || emptyRoster.show}
                  title={
                    emptyRoster.show
                      ? t("submissions.collect.titleEmptyRoster")
                      : regrading
                        ? t("submissions.collect.titleRegrading")
                        : t("submissions.collect.title")
                  }
                  onClick={() => {
                    if (collecting || regrading || emptyRoster.show) return
                    collectScores.collect()
                  }}
                >
                  {collecting && (
                    <span
                      className="loading loading-spinner loading-xs"
                      aria-hidden="true"
                    />
                  )}
                  {collecting
                    ? t("submissions.collect.active")
                    : t("submissions.collect.label")}
                </button>
                <a
                  className="btn btn-sm btn-ghost"
                  href={viewRun?.html_url || viewWorkflowUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink aria-hidden="true" className="size-4" />
                  {viewLabel}
                </a>
              </div>
            </div>

            {/* Status strip — only when an action is active or recently
                finished. Color + copy reflect that one action. */}
            {activeAction === "collect" && collectScores.phase !== "idle" && (
              <div
                className="border-t border-info/20 px-4 py-2 text-sm"
                role="status"
                aria-live="polite"
              >
                {collectScores.phase === "dispatching" && (
                  <span className="text-base-content/70">
                    {t("submissions.collect.statusDispatching")}
                  </span>
                )}
                {collectScores.phase === "running" && (
                  <span className="flex items-center gap-1.5 text-base-content/70">
                    <span
                      className="loading loading-spinner loading-xs"
                      aria-hidden="true"
                    />
                    {t("submissions.collect.statusRunning")}
                  </span>
                )}
                {collectScores.phase === "completed" && (
                  <span className="text-success">
                    {t("submissions.collect.statusCompleted")}
                  </span>
                )}
                {collectScores.phase === "failed" && (
                  <span className="text-error">
                    {collectScores.error instanceof Error
                      ? t("submissions.collect.statusFailedWithReason", {
                          reason: collectScores.error.message,
                        })
                      : t("submissions.collect.statusFailed")}{" "}
                    {t("submissions.collect.statusFailedHint")}
                  </span>
                )}
                {collectScores.phase === "timeout" && (
                  <span className="text-base-content/70">
                    {t("submissions.collect.statusTimeout")}
                  </span>
                )}
              </div>
            )}
            {activeAction === "regrade" && regradeAll.phase !== "idle" && (
              <div
                className={`border-t px-4 py-2 text-sm ${
                  regradeAll.phase === "failed"
                    ? "border-error/20 text-error"
                    : regradeAll.phase === "completed"
                      ? "border-success/20 text-success"
                      : "border-warning/20 text-base-content/70"
                }`}
                role="status"
                aria-live="polite"
              >
                {regradeAll.phase === "dispatching" && (
                  <span>{t("submissions.regradeAll.statusDispatching")}</span>
                )}
                {regradeAll.phase === "running" && (
                  <span className="flex items-center gap-1.5">
                    <span
                      className="loading loading-spinner loading-xs"
                      aria-hidden="true"
                    />
                    {t("submissions.regradeAll.statusRunning")}
                  </span>
                )}
                {regradeAll.phase === "completed" && (
                  <span>
                    {t("submissions.regradeAll.statusCompleted_prefix")}{" "}
                    <span className="font-semibold">
                      {t("submissions.collect.label")}
                    </span>{" "}
                    {t("submissions.regradeAll.statusCompleted_suffix")}
                  </span>
                )}
                {regradeAll.phase === "failed" && (
                  <span>
                    {regradeAll.error instanceof Error
                      ? t("submissions.regradeAll.statusFailedWithReason", {
                          reason: regradeAll.error.message,
                        })
                      : t("submissions.regradeAll.statusFailed")}{" "}
                    {t("submissions.regradeAll.statusFailedHint")}
                  </span>
                )}
                {regradeAll.phase === "timeout" && (
                  <span>{t("submissions.regradeAll.statusTimeout")}</span>
                )}
              </div>
            )}
          </div>
          <details
            open
            className="card bg-base-100 rounded-xl border border-base-300 mb-4 group"
          >
            <summary className="card-body flex-row items-center gap-3 cursor-pointer list-none py-4">
              <div className="rounded-xl bg-primary/10 p-2.5 text-primary">
                <LinkIcon aria-hidden="true" className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="font-bold">{t("submissions.accept.heading")}</h2>
                <p className="text-sm text-base-content/70">
                  {t("submissions.accept.subheading")}
                </p>
              </div>
              <ChevronRight
                aria-hidden="true"
                className="size-5 shrink-0 text-base-content/70 transition-transform group-open:rotate-90"
              />
            </summary>
            <div className="card-body gap-4 pt-0">
              {secret ? (
                <p className="text-sm text-base-content/70">
                  {t("submissions.accept.unlistedNote")}
                </p>
              ) : null}

              <div className="flex justify-between bg-base-200 text-base-content border border-base-300 items-center">
                <pre className="overflow-x-auto px-4 py-3 text-sm">
                  <code>{assignmentSubmitUrl}</code>
                </pre>
                <CopyIconButton
                  copied={copiedSubmitLink}
                  onCopy={copySubmitLink}
                  label={t("submissions.accept.copyLink")}
                />
              </div>

              <details className="group/cli">
                <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-sm text-base-content/70 hover:text-base-content">
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 transition-transform group-open/cli:rotate-90"
                  />
                  {t("submissions.accept.preferCli")}
                </summary>
                <div className="mt-2 flex justify-between bg-base-200 text-base-content border border-base-300 items-center">
                  <pre className="overflow-x-auto px-4 py-3 text-sm">
                    <code>{assignmentSubmitCli}</code>
                  </pre>
                  <CopyIconButton
                    copied={copiedSubmitCli}
                    onCopy={copySubmitCli}
                    label={t("submissions.accept.copyCli")}
                  />
                </div>
              </details>
            </div>
          </details>{" "}
          <div className="grid grid-cols-2 gap-4 mb-6 lg:grid-cols-4">
            <StatCard
              label={
                isGroupAssignment
                  ? t("submissions.stats.groupsSubmitted")
                  : t("submissions.stats.submitted")
              }
            >
              <div className="flex items-baseline gap-1">
                <span className="text-2xl font-bold">{stats.submitted}</span>
                {isGroupAssignment ? null : (
                  <span className="text-base-content/70">
                    / {scopedStudents.length}
                  </span>
                )}
              </div>
            </StatCard>
            <StatCard label={t("submissions.stats.classAverage")}>
              {!scopedScores?.[0]?.["max-score"] ? (
                <span className="text-2xl font-bold">
                  {t("submissions.stats.notAvailable")}
                </span>
              ) : (
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-bold">
                    {avgScore ?? t("submissions.stats.notAvailable")}
                  </span>
                  <span className="text-base-content/70">
                    / {scopedScores?.[0]?.["max-score"]}
                  </span>
                </div>
              )}
            </StatCard>
            {passingEnabled && (
              <StatCard label={t("submissions.stats.passing")}>
                {stats.passing + stats.failing === 0 ? (
                  <span className="text-2xl font-bold">
                    {t("submissions.stats.notAvailable")}
                  </span>
                ) : (
                  <>
                    <div className="flex items-baseline gap-1">
                      <span className="text-2xl font-bold">
                        {stats.passing}
                      </span>
                      <span className="text-base-content/70">
                        / {stats.passing + stats.failing}
                      </span>
                    </div>
                    <span className="text-xs text-base-content/70">
                      {stats.failing > 0 ? (
                        <button
                          type="button"
                          className="link link-hover decoration-dotted underline-offset-2 hover:text-error"
                          onClick={showFailing}
                          title={t("submissions.stats.showFailing")}
                        >
                          {t("submissions.stats.failingCount", {
                            count: stats.failing,
                          })}
                        </button>
                      ) : (
                        <>
                          {t("submissions.stats.failingCount", {
                            count: stats.failing,
                          })}
                        </>
                      )}
                      {stats.ungraded > 0
                        ? t("submissions.stats.ungradedSuffix", {
                            count: stats.ungraded,
                          })
                        : ""}
                    </span>
                  </>
                )}
              </StatCard>
            )}
            {acceptedAvailable ? (
              <StatCard label={t("submissions.stats.accepted")}>
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-bold">{acceptedCount}</span>
                  <span className="text-base-content/70">
                    / {scopedStudents.length}
                  </span>
                </div>
                {acceptedNotSubmittedCount > 0 && (
                  <button
                    type="button"
                    className="link link-hover w-fit text-xs text-base-content/70 decoration-dotted underline-offset-2 hover:text-warning"
                    onClick={showAcceptedNotSubmitted}
                    title={t("submissions.stats.showAcceptedNotSubmitted")}
                  >
                    {t("submissions.stats.notYetSubmitted", {
                      count: acceptedNotSubmittedCount,
                    })}
                  </button>
                )}
              </StatCard>
            ) : null}
          </div>
          <div className="mb-2 flex items-center justify-end gap-1 text-sm text-base-content/70">
            <span>{t("submissions.updated", { when: scoresLastUpdated })}</span>

            <button
              type="button"
              className="btn btn-ghost btn-xs btn-circle"
              disabled={scoresFetching}
              onClick={() => refetchScores()}
              aria-label={t("submissions.refresh")}
              title={t("submissions.refresh")}
            >
              <RefreshCw
                aria-hidden="true"
                size={14}
                className={scoresFetching ? "animate-spin" : ""}
              />
            </button>
          </div>
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
        </DrawerContent>
        <DrawerSidebar selected="assignments" />
      </Drawer>
    </div>
  )
}

// The teacher gradebook. Students who land here directly (e.g. an old link)
// are redirected to their own submission view; we wait for the role to resolve
// so a real teacher never bounces. Gating here (before mounting the content)
// also avoids firing the teacher-only score/roster reads for a student.
const SubmissionsPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.submissions"))
  const { org, classroom, assignment } = useParams({ strict: false })
  const { showTeacherUi, roleResolved } = useCourseTeacherAccess(org)

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
