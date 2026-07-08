import {
  AlertTriangle,
  ChevronRight,
  Plus,
  RefreshCw,
  Search,
  Send,
  Upload,
  X,
} from "lucide-react"

import { nameFromParts } from "@/util/students"
import { Alert, Button, Card, Spinner } from "@/components/ui"
import Avatar from "@/components/avatar"
import type { Student } from "@/types/classroom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  syncRosterFromTeam,
  reconcileTeamFromOrgMembers,
} from "@/api/mutations/students"
import { getErrorMessage } from "@/hooks/github/mutations"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useGitHubViewer } from "@/hooks/github/hooks"
import {
  githubKeys,
  invalidateInviteQueries as invalidateInviteQueriesForOrg,
} from "@/hooks/github/queries"
import { useUpdateRosterCache } from "@/hooks/useGetStudents"
import { useTeamRoster, useInvalidateTeamRoster } from "@/hooks/useTeamRoster"
import type { TeamRosterRow, TeamRosterRowState } from "@/util/teamRoster"
import { studentKey, toStudent } from "@/util/roster"
import { isSameGitHubUser } from "@/util/students"
import { GitHubIdentity } from "@/pages/orgMembers/memberPresentation"
import {
  resolveSelectedRows,
  selectableRows,
  selectAllState,
  toggleSelectAll,
} from "@/pages/orgMembers/selection"
import { useRangeSelection } from "@/pages/orgMembers/useRangeSelection"
import { rosterRowToMemberRow, rosterRowInitials } from "@/util/memberRow"
import RosterMemberModal from "@/pages/students/RosterMemberModal"
import RosterBulkActionsBar, {
  type AddStudentActions,
} from "@/pages/students/RosterBulkActionsBar"
import type { StudentCsvRow } from "@/api/mutations/students"
import { AnimatePresence, motion } from "motion/react"
import { collapseVariants, enterExit } from "@/lib/motion"
import { ClickableRow } from "@/lib/motionComponents"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

// Group rows by `section`, sorted by name with the unlabeled ("No section")
// bucket last. Generic over any row with a `section` field.
const NO_SECTION = "No section"
export function groupStudentsBySection<T extends { section?: string }>(
  students: T[],
): Array<{ section: string; students: T[] }> {
  const bySection = new Map<string, T[]>()
  for (const student of students) {
    const label = student.section?.trim() || NO_SECTION
    const bucket = bySection.get(label)
    if (bucket) bucket.push(student)
    else bySection.set(label, [student])
  }
  return Array.from(bySection.entries())
    .sort(([a], [b]) => {
      if (a === NO_SECTION) return 1
      if (b === NO_SECTION) return -1
      return a.localeCompare(b, undefined, { numeric: true })
    })
    .map(([section, group]) => ({ section, students: group }))
}

// Status filter values for the unified list.
type StatusFilter = "all" | TeamRosterRowState

const EnrolledStudents = ({
  students = [],
  org,
  classroom,
  addActions,
}: {
  students: Student[]
  org: string
  classroom: string
  addActions?: AddStudentActions
}) => {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const { notify } = useToast()
  const { data: viewer } = useGitHubViewer()
  const updateRosterCache = useUpdateRosterCache(org, classroom)
  const invalidateTeamRoster = useInvalidateTeamRoster(org, classroom)

  // Keyed by row.key so a clean action can't clobber another's warning.
  const [warnings, setWarnings] = useState<Record<string, string>>({})
  const [groupBySection, setGroupBySection] = useState(false)
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [sectionFilter, setSectionFilter] = useState<string>("all")
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  // Session-only banner dismissal — a page refresh re-derives roster state and
  // shows them again.
  const [driftDismissed, setDriftDismissed] = useState(false)
  const [pendingDismissed, setPendingDismissed] = useState(false)

  const {
    rows,
    counts,
    isLoading,
    isError,
    isEmpty,
    pendingHidden,
    teamSlug,
    csvMissingCount,
    notInOrgUsernames,
  } = useTeamRoster(org, classroom, students)

  const notInOrg = useMemo(
    () => rows.filter((r) => r.state === "not_in_org"),
    [rows],
  )

  const setWarning = (key: string, message: string) =>
    setWarnings((prev) => ({ ...prev, [key]: message }))
  const dismissWarning = (key: string) =>
    setWarnings((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })

  const invalidateInviteQueries = () =>
    invalidateInviteQueriesForOrg(queryClient, org)

  // A row is selectable unless it's the signed-in teacher (can't bulk-unenroll
  // yourself), mirroring Org Members' self-exclusion.
  const isSelf = (row: TeamRosterRow) =>
    isSameGitHubUser(viewer ?? null, {
      github_id: row.github_id,
      username: row.username,
    })
  const isSelectable = (row: TeamRosterRow) => !isSelf(row)

  // Distinct sections present across all rows (status-independent so switching
  // status never empties the section dropdown), sorted with "No section" last.
  // Only offered when at least one row carries a real section label.
  const sectionOptions = useMemo(() => {
    const labels = new Set<string>()
    let hasUnsectioned = false
    for (const row of rows) {
      const label = row.section.trim()
      if (label) labels.add(label)
      else hasUnsectioned = true
    }
    if (labels.size === 0) return []
    const sorted = Array.from(labels).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    )
    return hasUnsectioned ? [...sorted, NO_SECTION] : sorted
  }, [rows])

  // A previously-selected section can vanish (roster edit / unenroll); treat a
  // stale selection as "all" rather than filtering on a section that no longer
  // exists. Derived (not synced via effect) so it never lags a row change.
  const effectiveSection =
    sectionFilter !== "all" && sectionOptions.includes(sectionFilter)
      ? sectionFilter
      : "all"

  // Text search over username/name/email + the status and section filters.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((row) => {
      if (statusFilter !== "all" && row.state !== statusFilter) return false
      if (effectiveSection !== "all") {
        const section = row.section.trim() || NO_SECTION
        if (section !== effectiveSection) return false
      }
      if (!q) return true
      const name = nameFromParts(row.first_name, row.last_name)
      return [row.username, name, row.email].some((field) =>
        field.toLowerCase().includes(q),
      )
    })
  }, [rows, query, statusFilter, effectiveSection])

  const hasSectionsInFiltered = useMemo(
    () => filtered.some((r) => r.section.trim()),
    [filtered],
  )
  const filteredBySection = useMemo(
    () => groupStudentsBySection(filtered),
    [filtered],
  )

  const selected = useMemo(
    () => rows.find((row) => row.key === selectedKey) ?? null,
    [rows, selectedKey],
  )

  const selectedRows = useMemo(
    () => resolveSelectedRows(rows, selectedKeys, isSelectable),
    // isSelectable depends on viewer; recompute when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, selectedKeys, viewer],
  )
  const selectableFiltered = useMemo(
    () => selectableRows(filtered, isSelectable),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, viewer],
  )
  const { allSelected, someSelected } = selectAllState(
    selectableFiltered,
    selectedKeys,
  )
  const handleToggleSelectAll = () =>
    setSelectedKeys((prev) => toggleSelectAll(selectableFiltered, prev))

  // group-by-section reorders rows into buckets, so a shift-range must span
  // that rendered order, not the flat filtered list.
  const renderedOrder = useMemo(
    () =>
      groupBySection && hasSectionsInFiltered
        ? filteredBySection.flatMap((g) => g.students)
        : filtered,
    [groupBySection, hasSectionsInFiltered, filteredBySection, filtered],
  )

  // Shift-click range selection over the rendered order (group-by-section
  // aware), so a shift-range fills the span the user actually sees.
  const { handleToggleRow, handleRowCheckboxClick } = useRangeSelection(
    renderedOrder,
    isSelectable,
    setSelectedKeys,
  )

  // Status-filter options; hide "Pending" when invites are owner-only and this
  // viewer can't read them (avoids a dead, always-empty filter).
  const statusOptions: { value: StatusFilter; label: string }[] = [
    { value: "all", label: t("students.filterAll") },
    { value: "enrolled", label: t("students.filterEnrolled") },
    ...(pendingHidden
      ? []
      : [{ value: "pending" as const, label: t("students.filterPending") }]),
    { value: "not_in_org", label: t("students.filterNotInOrg") },
  ]

  // Explicit teacher-triggered CSV backfill (also auto-run on open).
  const syncMutation = useMutation({
    mutationFn: () => syncRosterFromTeam(client, { org, classroom }),
    onSuccess: (result) => {
      notify({
        tone: "success",
        durationMs: 5000,
        message: result.noop
          ? t("students.syncUpToDate")
          : t("students.syncAdded", { count: result.addedUsernames.length }),
      })
      void queryClient.invalidateQueries({
        queryKey: githubKeys.csvFile(
          org,
          "classroom50",
          `${classroom}/students.csv`,
        ),
      })
    },
    onError: (err) => {
      notify({
        tone: "error",
        message: t("students.syncFailed", { error: getErrorMessage(err) }),
      })
    },
  })

  // Auto-sync on open: append team members lacking a CSV row (fire once per
  // drift episode; re-arm when count returns to 0).
  //
  // suppressAutoSyncRef blocks the NEXT drift episode after a teacher-initiated
  // unenroll: bulkUnenrollStudents/unenrollStudent drop the CSV row first and
  // then best-effort remove team membership, so a transient team-drop failure
  // leaves a live team member with no CSV row (csvMissingCount > 0). Without
  // this guard, auto-sync would immediately re-append that just-removed student,
  // silently reversing the unenroll behind a soft warning toast. We only defer
  // the AUTOMATIC backfill — the explicit Sync button (and a fresh page open)
  // still runs it — so a real drift the teacher wants backfilled is one click
  // away, but an unenroll no longer undoes itself on its own.
  const autoSyncedRef = useRef(false)
  const suppressAutoSyncRef = useRef(false)
  useEffect(() => {
    if (isLoading || isError) return
    if (csvMissingCount === 0) {
      autoSyncedRef.current = false
      return
    }
    if (suppressAutoSyncRef.current) {
      // Consume the one-episode suppression: latch as if we synced so this
      // drift episode is skipped, and let the next fresh episode auto-sync.
      suppressAutoSyncRef.current = false
      autoSyncedRef.current = true
      return
    }
    if (autoSyncedRef.current || syncMutation.isPending) return
    autoSyncedRef.current = true
    syncMutation.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csvMissingCount, isLoading, isError])

  // Auto-reconcile on open: team-add rostered not_in_org usernames that are in
  // fact active org members (native invite / SSO).
  const reconcileMutation = useMutation({
    mutationFn: (usernames: string[]) =>
      reconcileTeamFromOrgMembers(client, { org, classroom, usernames }),
    onSuccess: (result) => {
      if (result.added.length > 0) {
        invalidateTeamRoster()
        notify({
          tone: "success",
          durationMs: 5000,
          message: t("students.reconcileAdded", { count: result.added.length }),
        })
      }
      if (result.failed.length > 0) {
        notify({
          tone: "warning",
          durationMs: 8000,
          message: t("students.reconcileFailed", {
            list: result.failed.map((f) => f.login).join(", "),
          }),
        })
      }
    },
    onError: (err) => {
      notify({
        tone: "error",
        message: t("students.reconcileError", { error: getErrorMessage(err) }),
      })
    },
  })

  const autoReconciledRef = useRef(false)
  const notInOrgCount = notInOrgUsernames.length
  useEffect(() => {
    if (isLoading || isError) return
    if (notInOrgCount === 0) {
      autoReconciledRef.current = false
      return
    }
    if (autoReconciledRef.current || reconcileMutation.isPending) return
    autoReconciledRef.current = true
    reconcileMutation.mutate(notInOrgUsernames)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notInOrgCount, isLoading, isError])

  const onRowMetadataSaved = (rowKey: string, updated: StudentCsvRow) => {
    updateRosterCache((current) => {
      const next = current.map((s) =>
        studentKey(s) === rowKey ? toStudent(updated) : s,
      )
      const exists = current.some((s) => studentKey(s) === rowKey)
      return exists ? next : [...next, toStudent(updated)]
    })
    invalidateInviteQueries()
  }

  const onRowUnenrolled = (rowKey: string, teamWarning?: string) => {
    if (teamWarning) setWarning(rowKey, teamWarning)
    // A failed team-drop would leave an orphaned team member; don't let the next
    // auto-sync re-append the student the teacher just removed (see the effect).
    suppressAutoSyncRef.current = true
    updateRosterCache((current) =>
      current.filter((s) => studentKey(s) !== rowKey),
    )
    setSelectedKeys((prev) => {
      const nextSet = new Set(prev)
      nextSet.delete(rowKey)
      return nextSet
    })
    invalidateInviteQueries()
    invalidateTeamRoster()
  }

  // After a bulk run, clear the selection and refresh the caches the run
  // touched (roster team membership + pending invites).
  const onBulkDone = (action: "unenroll" | "invite") => {
    setSelectedKeys(new Set())
    invalidateInviteQueries()
    // Unenroll changes team membership; invite changes org-invite state and may
    // team-add an already-active member — refresh the enrolled roster for both.
    invalidateTeamRoster()
    // After a bulk unenroll, defer the next auto-sync: a per-row team-drop that
    // failed would otherwise make auto-sync re-append the just-removed student.
    if (action === "unenroll") suppressAutoSyncRef.current = true
  }

  const renderRow = (row: TeamRosterRow) => {
    const member = rosterRowToMemberRow(row)
    const displayName = member.name
    const displayHandle = row.username || row.email
    const displayInitials = rosterRowInitials(row)
    const selfRow = isSelf(row)

    return (
      <ClickableRow
        key={row.key}
        className="group/row flex cursor-pointer items-center justify-between gap-4 px-6 py-4 hover:bg-base-200"
        role="button"
        tabIndex={0}
        onClick={() => setSelectedKey(row.key)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            setSelectedKey(row.key)
          }
        }}
      >
        <input
          type="checkbox"
          className="checkbox checkbox-sm shrink-0"
          aria-label={
            selfRow
              ? t("students.bulk.selfNotSelectable")
              : t("students.bulk.selectRow", { label: displayHandle })
          }
          disabled={selfRow}
          title={selfRow ? t("students.bulk.selfNotSelectable") : undefined}
          checked={selectedKeys.has(row.key)}
          onClick={(e) => {
            e.stopPropagation()
            handleRowCheckboxClick(e, row.key)
          }}
          onChange={() => handleToggleRow(row.key)}
        />
        <div className="min-w-0 flex-1">
          <Avatar
            name={displayName}
            github={displayHandle}
            initials={displayInitials}
            subtitle={<GitHubIdentity row={member} />}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {row.section.trim() ? (
            <span className="badge badge-sm badge-info badge-soft shrink-0">
              {row.section.trim()}
            </span>
          ) : null}
          {row.state === "pending" ? (
            <span className="badge badge-sm badge-warning badge-soft shrink-0">
              {t("students.statusPending")}
            </span>
          ) : null}
          {row.state === "not_in_org" ? (
            <span className="badge badge-sm badge-error badge-soft shrink-0">
              {t("students.statusNotInOrg")}
            </span>
          ) : null}
          <ChevronRight
            aria-hidden="true"
            className="size-4 text-base-content/30 transition-transform duration-150 group-hover/row:translate-x-0.5 group-hover/row:text-base-content/70"
          />
        </div>
      </ClickableRow>
    )
  }

  return (
    <div className="flex w-full flex-col gap-6">
      {/* Warnings / action results. */}
      {Object.keys(warnings).length > 0 ? (
        <div className="flex w-full flex-col gap-2">
          <AnimatePresence initial={false}>
            {Object.entries(warnings).map(([key, warning]) => (
              <motion.div
                key={key}
                layout
                variants={collapseVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                role="alert"
                className="alert alert-warning alert-soft overflow-hidden"
              >
                <span className="text-sm">{warning}</span>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => dismissWarning(key)}
                >
                  {t("students.dismiss")}
                </Button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      ) : null}

      {/* Count-only drift banner: clicking "Review" filters the list to
          not_in_org rather than expanding an inline list. Dismissable for the
          session; a refresh re-derives and shows it again. */}
      {!isLoading && !isError && !driftDismissed && notInOrg.length > 0 ? (
        <Alert
          tone="warning"
          className="flex items-center justify-between gap-3"
        >
          <span className="flex items-center gap-2 text-sm">
            <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
            {t("students.driftBanner", { count: notInOrg.length })}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setStatusFilter("not_in_org")
              }}
            >
              {t("students.driftReview")}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              shape="square"
              aria-label={t("students.dismiss")}
              title={t("students.dismiss")}
              onClick={() => setDriftDismissed(true)}
            >
              <X aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </Alert>
      ) : null}

      {/* Pending-invites banner: clicking "Review" filters to pending so the
          teacher can select rows and bulk-resend (cancel + re-send).
          Dismissable for the session. */}
      {!isLoading &&
      !isError &&
      !pendingHidden &&
      !pendingDismissed &&
      counts.pending > 0 ? (
        <Alert tone="info" className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-sm">
            <Send aria-hidden="true" className="size-4 shrink-0" />
            {t("students.pendingBanner", { count: counts.pending })}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setStatusFilter("pending")}
            >
              {t("students.pendingReview")}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              shape="square"
              aria-label={t("students.dismiss")}
              title={t("students.dismiss")}
              onClick={() => setPendingDismissed(true)}
            >
              <X aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </Alert>
      ) : null}

      {/* Non-owner: pending invites are owner-only. */}
      {!isLoading && !isError && pendingHidden ? (
        <Alert tone="error">
          <span className="text-sm">{t("students.pendingOwnerOnly")}</span>
        </Alert>
      ) : null}

      {/* Toolbar: search + status filter (group-by-section lives in the table
          header next to the count). Sync pinned far-right when applicable. */}
      {!isLoading && !isError && !isEmpty ? (
        <div className="flex flex-wrap items-center gap-3">
          <label className="input input-bordered flex min-w-0 flex-1 items-center gap-2">
            <Search aria-hidden="true" className="size-4 opacity-50" />
            <input
              type="search"
              className="grow"
              placeholder={t("students.searchPlaceholder")}
              aria-label={t("students.searchLabel")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <select
            className="select select-bordered w-full sm:w-auto"
            aria-label={t("students.filterByStatusLabel")}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          >
            {statusOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {sectionOptions.length > 0 ? (
            <select
              className="select select-bordered w-full sm:w-auto"
              aria-label={t("students.filterBySectionLabel")}
              value={effectiveSection}
              onChange={(e) => setSectionFilter(e.target.value)}
            >
              <option value="all">{t("students.filterAllSections")}</option>
              {sectionOptions.map((section) => (
                <option key={section} value={section}>
                  {section === NO_SECTION ? t("students.noSection") : section}
                </option>
              ))}
            </select>
          ) : null}
          {syncMutation.isPending || csvMissingCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              disabled={syncMutation.isPending}
              onClick={() => {
                // Explicit backfill: clear any post-unenroll suppression so the
                // teacher's deliberate Sync always runs.
                suppressAutoSyncRef.current = false
                syncMutation.mutate()
              }}
              aria-label={t("students.syncRosterTitle")}
              title={t("students.syncRosterTitle")}
            >
              <RefreshCw
                aria-hidden="true"
                className={`size-4 ${syncMutation.isPending ? "animate-spin" : ""}`}
              />
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* The list card. */}
      <Card className="w-full overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center gap-3 px-6 py-12 text-base-content/70">
            <Spinner size="md" />
            <span className="text-sm">{t("students.loadingRoster")}</span>
          </div>
        ) : isError ? (
          <div
            role="alert"
            className="flex flex-col items-center gap-3 px-6 py-10 text-center"
          >
            <span className="flex items-center gap-2 text-sm text-error">
              <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
              {t("students.rosterLoadError")}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void queryClient.invalidateQueries({
                  queryKey: githubKeys.teamMembers(org, teamSlug),
                })
              }
            >
              <RefreshCw aria-hidden="true" className="size-4" />
              {t("students.rosterRetry")}
            </Button>
          </div>
        ) : isEmpty ? (
          <div className="px-6 py-12 text-center">
            <h3 className="text-base font-semibold">
              {t("students.emptyTitle")}
            </h3>
            <p className="mt-2 text-sm text-base-content/70">
              {t("students.emptyBody")}
            </p>
            {addActions ? (
              <div className="mt-4 flex justify-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={addActions.onAddStudent}
                >
                  <Plus aria-hidden="true" className="size-4" />
                  {t("students.addTitle")}
                </Button>
                <Button size="sm" onClick={addActions.onUploadRoster}>
                  <Upload aria-hidden="true" className="size-4" />
                  {t("students.uploadRosterTitle")}
                </Button>
                <Button size="sm" onClick={addActions.onInviteLinks}>
                  <Send aria-hidden="true" className="size-4" />
                  {t("students.inviteStudents")}
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <RosterBulkActionsBar
              org={org}
              classroom={classroom}
              client={client}
              selectedRows={selectedRows}
              totalCount={filtered.length}
              allSelected={allSelected}
              someSelected={someSelected}
              onToggleSelectAll={handleToggleSelectAll}
              onClearSelection={() => setSelectedKeys(new Set())}
              onDone={onBulkDone}
              addActions={addActions}
              groupBySection={groupBySection}
              onGroupBySectionChange={setGroupBySection}
              canGroupBySection={hasSectionsInFiltered}
            />
            {filtered.length === 0 ? (
              <div className="px-6 py-10 text-center text-sm text-base-content/70">
                {query.trim()
                  ? t("students.noMatch")
                  : effectiveSection !== "all" && statusFilter === "all"
                    ? t("students.noneInSection", {
                        section:
                          effectiveSection === NO_SECTION
                            ? t("students.noSection")
                            : effectiveSection,
                      })
                    : t("students.noneWithStatus", {
                        status:
                          statusOptions.find((o) => o.value === statusFilter)
                            ?.label ?? statusFilter,
                      })}
              </div>
            ) : groupBySection && hasSectionsInFiltered ? (
              <div className="divide-y divide-base-300">
                {filteredBySection.map(({ section, students: group }) => (
                  <div key={section}>
                    <div className="flex items-center justify-between bg-base-200/60 px-6 py-2">
                      <h3 className="text-sm font-semibold text-base-content/70">
                        {section === NO_SECTION
                          ? t("students.noSection")
                          : section}
                      </h3>
                      <span className="badge badge-ghost badge-sm">
                        {group.length}
                      </span>
                    </div>
                    <motion.ul
                      className="divide-y divide-base-300"
                      variants={enterExit}
                      initial="initial"
                      animate="animate"
                    >
                      {group.map((row) => renderRow(row))}
                    </motion.ul>
                  </div>
                ))}
              </div>
            ) : (
              <motion.ul
                className="divide-y divide-base-300"
                variants={enterExit}
                initial="initial"
                animate="animate"
              >
                {filtered.map((row) => renderRow(row))}
              </motion.ul>
            )}
          </>
        )}
      </Card>

      <RosterMemberModal
        open={Boolean(selected)}
        org={org}
        classroom={classroom}
        teamSlug={teamSlug}
        row={selected}
        onClose={() => setSelectedKey(null)}
        onSaved={(rowKey, updated) => onRowMetadataSaved(rowKey, updated)}
        onUnenrolled={(rowKey, teamWarning) =>
          onRowUnenrolled(rowKey, teamWarning)
        }
        onResent={(rowKey) => {
          dismissWarning(rowKey)
          invalidateInviteQueries()
        }}
        onError={(rowKey, message) => setWarning(rowKey, message)}
      />
    </div>
  )
}

export default EnrolledStudents
