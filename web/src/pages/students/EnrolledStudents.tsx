import {
  AlertTriangle,
  ChevronRight,
  Plus,
  RefreshCw,
  Send,
  Upload,
  X,
} from "lucide-react"

import {
  Alert,
  AnimatedAlert,
  Badge,
  Button,
  Card,
  Spinner,
  Toolbar,
} from "@/components/ui"
import Avatar from "@/components/avatar"
import type { Student } from "@/types/classroom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  syncRosterFromTeam,
  reconcileTeamFromOrgMembers,
  migrateRosterFile,
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
import {
  dropSuppressed,
  type SuppressedLogins,
} from "@/hooks/useSuppressedLogins"
import type { TeamRosterRow, RosterRole } from "@/util/teamRoster"
import { STAFF_ROLES } from "@/types/classroom"
import {
  ROLE_LABEL_KEY,
  ROLE_BADGE_TONE,
  hasStudentEnrollment,
  primaryRole,
} from "@/util/rosterRoles"
import {
  filterRosterRows,
  NO_SECTION,
  type RoleFilter,
  type StatusFilter,
} from "@/pages/students/rosterFilter"
import { studentKey, toStudent } from "@/util/roster"
import { rosterPath } from "@/util/rosterPath"
import { isSameGitHubUser } from "@/util/students"
import { GitHubIdentity } from "@/pages/orgMembers/memberPresentation"
import {
  resolveSelectedRows,
  selectableRows,
  selectAllState,
  shouldWarnNoneSelectable,
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

const EnrolledStudents = ({
  students = [],
  org,
  classroom,
  addActions,
  suppressedLogins,
}: {
  students: Student[]
  org: string
  classroom: string
  addActions?: AddStudentActions
  // Session-unenrolled logins, owned by the parent so a re-enroll from the Add
  // modal can clear a login this view suppressed. Shared, not local, so the two
  // surfaces can't disagree on who's suppressed.
  suppressedLogins: SuppressedLogins
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
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all")
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
    csvMissingLogins,
    notInOrgUsernames,
    refetch: refetchRoster,
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
  // yourself), mirroring Org Members' self-exclusion. A pure staff row (no
  // student enrollment) isn't selectable either: bulk-unenroll drops the CSV row
  // + student-team membership, so it only applies to rows with a student
  // enrollment. A student who is ALSO staff IS selectable — unenroll drops only
  // their student side and leaves the staff role intact — matching the row
  // modal's unenroll gate (both use hasStudentEnrollment) so the two never
  // diverge (previously a student+instructor was removable in the modal but
  // silently skipped by select-all).
  const isSelf = (row: TeamRosterRow) =>
    isSameGitHubUser(viewer ?? null, {
      github_id: row.github_id,
      username: row.username,
    })
  const isSelectable = (row: TeamRosterRow) =>
    !isSelf(row) && hasStudentEnrollment(row)

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

  // Role filter options: student is always offered; a staff role appears only
  // when at least one row holds it (so a class with no TAs has no dead "TA"
  // filter). Ordered student-first, then staff roles per the STAFF_ROLES source.
  const roleFilterOptions = useMemo(() => {
    const present = new Set<RosterRole>()
    for (const row of rows) for (const role of row.roles) present.add(role)
    return (["student", ...STAFF_ROLES] as RosterRole[]).filter((role) =>
      present.has(role),
    )
  }, [rows])

  // A stale role selection (the last instructor/TA was removed) falls back to
  // "all" so the list never filters on a role no row carries.
  const effectiveRole =
    roleFilter !== "all" && roleFilterOptions.includes(roleFilter)
      ? roleFilter
      : "all"

  // Text search over username/name/email + the status, role, and section
  // filters (see filterRosterRows — extracted so the facets are unit-tested).
  const filtered = useMemo(
    () =>
      filterRosterRows(rows, {
        query,
        statusFilter,
        roleFilter: effectiveRole,
        sectionFilter: effectiveSection,
      }),
    [rows, query, statusFilter, effectiveRole, effectiveSection],
  )

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
  const handleToggleSelectAll = () => {
    // Select-all only ever targets selectable (student-only) rows. When the
    // current view has rows but none are selectable — e.g. filtered to staff —
    // the click would silently no-op, so explain why instead.
    if (shouldWarnNoneSelectable(filtered.length, selectableFiltered.length)) {
      notify({
        tone: "info",
        durationMs: 6000,
        message: t("students.bulk.noneSelectable"),
      })
      return
    }
    if (selectableFiltered.length === 0) return
    setSelectedKeys((prev) => toggleSelectAll(selectableFiltered, prev))
  }

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

  // Auto-migrate on open: converge a classroom bootstrapped before the
  // students.csv -> roster.csv rename so roster.csv always physically exists.
  // Idempotent and cheap (a no-op once roster.csv is present). It runs BEFORE
  // auto-sync (which gates on migrateSettledFor) so the two roster writers don't
  // race on the ref. The rename changes only the file's path, not its content,
  // and reads already fall back to students.csv, so there's no cache to
  // invalidate — a plain invalidate here would refetch eventually-consistent
  // bytes and needlessly re-arm auto-sync.
  const [migrateSettledFor, setMigrateSettledFor] = useState<string | null>(
    null,
  )
  const migrateMutation = useMutation({
    mutationFn: () => migrateRosterFile(client, { org, classroom }),
    onSettled: () => setMigrateSettledFor(classroom),
    // Best-effort convergence: a failure is non-fatal (reads still fall back to
    // students.csv), so it's logged by the mutation layer, not surfaced — and
    // onSettled still unblocks auto-sync so a migrate hiccup can't strand it.
  })
  // Fire once per classroom (the component instance is reused across a
  // $classroom param switch, so a boolean would skip later classrooms).
  const migratedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (isLoading || isError) return
    if (migratedForRef.current === classroom) return
    migratedForRef.current = classroom
    setMigrateSettledFor(null)
    migrateMutation.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classroom, isLoading, isError])

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
        queryKey: githubKeys.csvFile(org, "classroom50", rosterPath(classroom)),
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
  // drift episode; re-arm when count returns to 0). Gated on migrate having
  // settled for this classroom so the two roster writers run in sequence, not a
  // race. dropSuppressed skips any csv-missing member the teacher just
  // unenrolled whose best-effort team-drop failed — otherwise auto-sync would
  // re-append the student it just removed. (suppressedLogins is read in the
  // effect, not during render; syncRosterFromTeam re-derives the authoritative
  // set server-side.)
  const autoSyncedRef = useRef(false)
  const csvMissingKey = csvMissingLogins.join(",")
  useEffect(() => {
    if (isLoading || isError) return
    // Wait for the migrate pass to settle first (converges students.csv ->
    // roster.csv) so sync's write can't race migrate's on the ref.
    if (migrateSettledFor !== classroom) return
    if (dropSuppressed(csvMissingLogins, suppressedLogins).length === 0) {
      autoSyncedRef.current = false
      return
    }
    if (autoSyncedRef.current || syncMutation.isPending) return
    autoSyncedRef.current = true
    syncMutation.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csvMissingKey, isLoading, isError, migrateSettledFor, classroom])

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
  // dropSuppressed runs in the effect (read after render) so a teacher's
  // leftover active org membership isn't silently promoted back onto the team —
  // the root of the "unenrolled student keeps coming back" loop.
  const notInOrgKey = notInOrgUsernames.join(",")
  useEffect(() => {
    if (isLoading || isError) return
    const targets = dropSuppressed(notInOrgUsernames, suppressedLogins)
    if (targets.length === 0) {
      autoReconciledRef.current = false
      return
    }
    if (autoReconciledRef.current || reconcileMutation.isPending) return
    autoReconciledRef.current = true
    reconcileMutation.mutate(targets)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notInOrgKey, isLoading, isError])

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
    // Remember this login so the automatic backfills (auto-sync, auto-reconcile)
    // don't re-add the student the teacher just removed — e.g. when a
    // best-effort team-drop failed, or the CSV delete hasn't propagated and they
    // resurface as not_in_org while still an active org member.
    const removed = rows.find((r) => r.key === rowKey)
    if (removed?.username) suppressedLogins.remember([removed.username])
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
  const onBulkDone = (
    action: "unenroll" | "invite",
    removed?: Array<Pick<TeamRosterRow, "username">>,
  ) => {
    setSelectedKeys(new Set())
    invalidateInviteQueries()
    // Unenroll changes team membership; invite changes org-invite state and may
    // team-add an already-active member — refresh the enrolled roster for both.
    invalidateTeamRoster()
    // After a bulk unenroll, remember the removed logins so the automatic
    // backfills don't re-add them (see the effects). Only confirmed-removed rows
    // are passed (not selection misses), so a still-enrolled row isn't
    // suppressed by mistake.
    if (action === "unenroll" && removed)
      suppressedLogins.remember(removed.map((r) => r.username))
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
          {(() => {
            // Show only the person's highest-precedence role (instructor > ta >
            // student), so a member on multiple teams reads as one primary role
            // rather than a stack of chips. The student chip uses the neutral
            // ghost style; staff roles use their tone.
            const role = primaryRole(row)
            return (
              <Badge
                size="sm"
                tone={ROLE_BADGE_TONE[role]}
                ghost={role === "student"}
                className="shrink-0"
              >
                {t(ROLE_LABEL_KEY[role])}
              </Badge>
            )
          })()}
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
      <AnimatedAlert
        tone="info"
        show={
          !isLoading &&
          !isError &&
          !pendingHidden &&
          !pendingDismissed &&
          counts.pending > 0
        }
        className="flex items-center justify-between gap-3"
      >
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
      </AnimatedAlert>

      {/* Non-owner: pending invites are owner-only. */}
      {!isLoading && !isError && pendingHidden ? (
        <Alert tone="error">
          <span className="text-sm">{t("students.pendingOwnerOnly")}</span>
        </Alert>
      ) : null}

      {/* Toolbar: search + status filter (group-by-section lives in the table
          header next to the count). Sync pinned far-right when applicable. */}
      {!isLoading && !isError && !isEmpty ? (
        <Toolbar className="gap-3">
          <Toolbar.Search
            inputSize="md"
            className="w-auto min-w-0 flex-1"
            iconClassName="opacity-50"
            placeholder={t("students.searchPlaceholder")}
            ariaLabel={t("students.searchLabel")}
            value={query}
            onChange={setQuery}
          />
          <Toolbar.FilterSelect
            selectSize="md"
            className="w-full sm:w-auto"
            aria-label={t("students.filterByStatusLabel")}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          >
            {statusOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Toolbar.FilterSelect>
          {roleFilterOptions.some((r) => r !== "student") ? (
            <Toolbar.FilterSelect
              selectSize="md"
              className="w-full sm:w-auto"
              aria-label={t("students.filterByRoleLabel")}
              value={effectiveRole}
              onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}
            >
              <option value="all">{t("students.filterAllRoles")}</option>
              {roleFilterOptions.map((role) => (
                <option key={role} value={role}>
                  {t(ROLE_LABEL_KEY[role])}
                </option>
              ))}
            </Toolbar.FilterSelect>
          ) : null}
          {sectionOptions.length > 0 ? (
            <Toolbar.FilterSelect
              selectSize="md"
              className="w-full sm:w-auto"
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
            </Toolbar.FilterSelect>
          ) : null}
          {syncMutation.isPending || csvMissingCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              disabled={syncMutation.isPending}
              onClick={() => {
                // Explicit backfill: clear the post-unenroll suppression so the
                // teacher's deliberate Sync always runs (re-adding any drifted
                // team members, even ones removed earlier this session).
                suppressedLogins.clear()
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
        </Toolbar>
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
            <Button variant="ghost" size="sm" onClick={() => refetchRoster()}>
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
