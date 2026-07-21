import { AlertTriangle, Plus, RefreshCw, Send, Upload, X } from "lucide-react"

import {
  Alert,
  AnimatedAlert,
  Badge,
  Button,
  Card,
  Spinner,
  Toolbar,
} from "@/components/ui"
import type { Student } from "@/types/classroom"
import { useQueryClient } from "@tanstack/react-query"
import type { RosterCsvProblem } from "@/domain/students"
import { useDismissFailedInvite } from "@/hooks/mutations/useDismissFailedInvite"
import { getErrorMessage } from "@/github-core/errorMessage"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useIsOrgOwner } from "@/context/githubOrgRole/useIsOrgOwner"
import { useGitHubViewer } from "@/hooks/useGitHubResources"
import type { GitHubOrgInvitation } from "@/github-core/types"
import { invalidateInviteQueries as invalidateInviteQueriesForOrg } from "@/github-core/queries"
import { useUpdateRosterCache } from "@/hooks/useGetStudents"
import { useTeamRoster, useInvalidateTeamRoster } from "@/hooks/useTeamRoster"
import { useSyncRoster } from "@/hooks/mutations/useSyncRoster"
import { useReinviteFailedInvite } from "@/hooks/mutations/useReinviteFailedInvite"
import type { SuppressedLogins } from "@/hooks/useSuppressedLogins"
import type { TeamRosterRow, ClassroomRole } from "@/util/teamRoster"
import { STAFF_ROLES } from "@/types/classroom"
import { ROLE_LABEL_KEY, hasStudentEnrollment } from "@/util/classroomRoleUI"
import {
  filterRosterRows,
  NO_SECTION,
  type RoleFilter,
  type StatusFilter,
} from "@/pages/students/rosterFilter"
import { studentKey, toStudent } from "@/util/roster"
import { isSameGitHubUser } from "@/util/students"
import {
  resolveSelectedRows,
  selectableRows,
  selectAllState,
  shouldWarnNoneSelectable,
  toggleSelectAll,
} from "@/pages/orgMembers/selection"
import { useRangeSelection } from "@/pages/orgMembers/useRangeSelection"
import RosterMemberModal from "@/pages/students/RosterMemberModal"
import RosterBulkActionsBar, {
  type AddStudentActions,
} from "@/pages/students/RosterBulkActionsBar"
import type { StudentCsvRow } from "@/domain/students"
import { motion } from "motion/react"
import { enterExit } from "@/lib/motion"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  groupStudentsBySection,
  nextSelectedKeyAfterSave,
} from "./enrolledStudentsHelpers"
import { useRosterAutoMigrate } from "./useRosterAutoMigrate"
import { useRosterAutoSync } from "./useRosterAutoSync"
import { RosterRow } from "./RosterRow"
import { FailedInvitationsList } from "./FailedInvitationsList"
import { RosterParseProblems } from "./RosterParseProblems"
import { RosterWarnings } from "./RosterWarnings"

const EnrolledStudents = ({
  students = [],
  parseProblems = [],
  onRecheckRoster,
  rechecking = false,
  org,
  classroom,
  addActions,
  suppressedLogins,
}: {
  students: Student[]
  // Per-line problems from the strict roster.csv parse (empty when the file is
  // well-formed). Surfaced as a banner so the teacher can fix the file.
  parseProblems?: RosterCsvProblem[]
  // Re-read roster.csv so a teacher who just fixed it can re-verify in place.
  onRecheckRoster?: () => void
  // The recheck read is in flight (disables the button, shows a spinner).
  rechecking?: boolean
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
  // Roster invite / unenroll / role-change all hit owner-only org APIs
  // (createOrgInvitation, removeOrgMembership, setOrgMembershipRole). Gate the
  // per-member modal's management actions on an explicit org-owner check rather
  // than the old `!pendingHidden` proxy — GitHub is the true enforcer, this is
  // the UX gate.
  const { isOwner } = useIsOrgOwner()
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
  const [pendingDismissed, setPendingDismissed] = useState(false)

  const {
    rows,
    counts,
    isLoading,
    isError,
    isEmpty,
    pendingHidden,
    failedInvitations,
    teamSlugByRole,
    csvMissingCount,
    csvMissingLogins,
    backfillNeededLogins,
    orgMembersKnown,
    refetch: refetchRoster,
  } = useTeamRoster(org, classroom, students)

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

  // Dismiss a failed/expired invitation: cancel it on GitHub (removes it from
  // the failed list) and refresh. The hook owns the invite-query invalidation;
  // the error toast stays here so it skips on unmount.
  const dismissFailedInvite = useDismissFailedInvite(org)

  // Re-invite a failed/expired invitation: dismiss the dead one, then re-issue
  // an equivalent fresh invite — same classroom role (teacher -> org OWNER),
  // by username when known (carries the team) else by email. A login-less,
  // email-less invite can't be re-issued (dismiss-only). The hook owns the
  // invite-query invalidation; the error toast lives here so it skips when
  // unmounted.
  const reinviteFailedInvite = useReinviteFailedInvite(org, classroom, {
    noTarget: t("students.failedInviteNoTarget"),
    rateLimited: (who) => t("students.failedInviteRateLimited", { who }),
    notSent: (who) => t("students.failedInviteNotSent", { who }),
  })
  const reinvite = (inv: GitHubOrgInvitation) =>
    reinviteFailedInvite.mutate(inv, {
      onError: (err) =>
        notify({
          tone: "error",
          message: t("students.failedInviteReinviteError", {
            error: getErrorMessage(err),
          }),
        }),
    })

  // A row is selectable unless it's the signed-in teacher (can't bulk-unenroll
  // yourself), mirroring Org Members' self-exclusion. A pure staff row (no
  // student enrollment) isn't selectable either: bulk-unenroll drops the CSV row
  // + student-team membership, so it only applies to rows with a student
  // enrollment. A student who is ALSO staff IS selectable — unenroll drops only
  // their student side and leaves the staff role intact — matching the row
  // modal's unenroll gate (both use hasStudentEnrollment) so the two never
  // diverge (previously a student+teacher was removable in the modal but
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
    const present = new Set<ClassroomRole>()
    for (const row of rows) for (const role of row.roles) present.add(role)
    return (["student", ...STAFF_ROLES] as ClassroomRole[]).filter((role) =>
      present.has(role),
    )
  }, [rows])

  // A stale role selection (the last teacher/TA was removed) falls back to
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
  // viewer can't read them (avoids a dead, always-empty filter). The two
  // needs-attention options only exist when org membership is known (else those
  // rows are suppressed, so the filters would be dead).
  const statusOptions: { value: StatusFilter; label: string }[] = [
    { value: "all", label: t("students.filterAll") },
    { value: "enrolled", label: t("students.filterEnrolled") },
    ...(pendingHidden
      ? []
      : [{ value: "pending" as const, label: t("students.filterPending") }]),
    ...(orgMembersKnown
      ? [
          {
            value: "needs_attention_in_org" as const,
            label: t("students.filterNeedsAttentionInOrg"),
          },
          {
            value: "needs_attention_not_in_org" as const,
            label: t("students.filterNeedsAttentionNotInOrg"),
          },
        ]
      : []),
  ]

  // Auto-migrate on open (see useRosterAutoMigrate): converge a pre-rename
  // classroom so roster.csv physically exists, and gate auto-sync on its
  // settling so the two roster writers don't race.
  const { migrateSettledFor } = useRosterAutoMigrate(
    org,
    classroom,
    !isLoading && !isError,
  )

  // Explicit teacher-triggered CSV backfill (also auto-run on open). The hook
  // owns the roster-file invalidation that must always run; the toasts live
  // here so they skip when unmounted.
  const syncMutation = useSyncRoster(org, classroom)
  const runSync = () =>
    syncMutation.mutate(undefined, {
      onSuccess: (result) => {
        notify({
          tone: "success",
          durationMs: 5000,
          message: result.noop
            ? t("students.syncUpToDate")
            : t("students.syncAdded", { count: result.addedUsernames.length }),
        })
      },
      onError: (err) => {
        notify({
          tone: "error",
          message: t("students.syncFailed", { error: getErrorMessage(err) }),
        })
      },
    })

  // Auto-sync on open (see useRosterAutoSync): append team members lacking a
  // CSV row when there's drift, gated on migrate settling; the caller owns
  // runSync (and its toasts, which skip on unmount).
  useRosterAutoSync({
    classroom,
    ready: !isLoading && !isError,
    migrateSettledFor,
    csvMissingLogins,
    backfillNeededLogins,
    suppressedLogins,
    syncPending: syncMutation.isPending,
    runSync,
  })

  const onRowMetadataSaved = (rowKey: string, updated: StudentCsvRow) => {
    updateRosterCache((current) => {
      const next = current.map((s) =>
        studentKey(s) === rowKey ? toStudent(updated) : s,
      )
      const exists = current.some((s) => studentKey(s) === rowKey)
      return exists ? next : [...next, toStudent(updated)]
    })
    // Follow the row's key if a save ever moved it, so the open modal stays put.
    const nextKey = studentKey(updated)
    setSelectedKey((prev) => nextSelectedKeyAfterSave(prev, rowKey, nextKey))
    invalidateInviteQueries()
  }

  const onRowUnenrolled = (rowKey: string, teamWarning?: string) => {
    if (teamWarning) setWarning(rowKey, teamWarning)
    // Remember this login so the automatic backfill (auto-sync-on-open) doesn't
    // re-add the student the teacher just removed — e.g. when a best-effort
    // team-drop failed, or the CSV delete hasn't propagated yet.
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
    action: "unenroll" | "invite" | "cancel",
    removed?: Array<Pick<TeamRosterRow, "username">>,
  ) => {
    setSelectedKeys(new Set())
    invalidateInviteQueries()
    // Unenroll changes team membership; invite changes org-invite state and may
    // team-add an already-active member; cancel removes pending invites — refresh
    // the enrolled roster for all three.
    invalidateTeamRoster()
    // After a bulk unenroll, remember the removed logins so the automatic
    // backfills don't re-add them (see the effects). Only confirmed-removed rows
    // are passed (not selection misses), so a still-enrolled row isn't
    // suppressed by mistake.
    if (action === "unenroll" && removed)
      suppressedLogins.remember(removed.map((r) => r.username))
  }

  const renderRow = (row: TeamRosterRow) => (
    <RosterRow
      key={row.key}
      row={row}
      selfRow={isSelf(row)}
      checked={selectedKeys.has(row.key)}
      onOpen={setSelectedKey}
      onCheckboxClick={handleRowCheckboxClick}
      onToggle={handleToggleRow}
    />
  )

  return (
    <div className="flex w-full flex-col gap-6">
      {parseProblems.length > 0 ? (
        <RosterParseProblems
          parseProblems={parseProblems}
          org={org}
          classroom={classroom}
          onRecheckRoster={onRecheckRoster}
          rechecking={rechecking}
        />
      ) : null}

      {/* Per-row action warnings/results. */}
      {Object.keys(warnings).length > 0 ? (
        <RosterWarnings warnings={warnings} onDismiss={dismissWarning} />
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

      {/* Failed/expired invitations (owner-only). */}
      {!isLoading && !isError && failedInvitations.length > 0 ? (
        <FailedInvitationsList
          failedInvitations={failedInvitations}
          actionsDisabled={
            reinviteFailedInvite.isPending || dismissFailedInvite.isPending
          }
          onReinvite={reinvite}
          onDismiss={(inv) =>
            dismissFailedInvite.mutate(inv.id, {
              onError: (err) =>
                notify({
                  tone: "error",
                  message: t("students.failedInviteDismissError", {
                    error: getErrorMessage(err),
                  }),
                }),
            })
          }
        />
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
                runSync()
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
                  {t("students.uploadTitle")}
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
                      <Badge ghost>{group.length}</Badge>
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
        teamSlugByRole={teamSlugByRole}
        row={selected}
        canManage={isOwner}
        isSelf={selected ? isSelf(selected) : false}
        onClose={() => setSelectedKey(null)}
        onSaved={(rowKey, updated) => onRowMetadataSaved(rowKey, updated)}
        onUnenrolled={(rowKey, teamWarning) =>
          onRowUnenrolled(rowKey, teamWarning)
        }
        onResent={(rowKey) => {
          dismissWarning(rowKey)
          invalidateInviteQueries()
        }}
        onCanceled={(rowKey) => {
          // A cancelled invite removes the pending person; refresh invite + team
          // caches so the row leaves the roster.
          dismissWarning(rowKey)
          invalidateInviteQueries()
          invalidateTeamRoster()
          refetchRoster()
        }}
        onChanged={(rowKey) => {
          dismissWarning(rowKey)
          invalidateInviteQueries()
          invalidateTeamRoster()
          refetchRoster()
        }}
        onError={(rowKey, message) => setWarning(rowKey, message)}
      />
    </div>
  )
}

export default EnrolledStudents
