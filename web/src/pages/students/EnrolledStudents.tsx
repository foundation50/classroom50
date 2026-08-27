import {
  AlertIcon,
  PaperAirplaneIcon,
  PeopleIcon,
  SyncIcon,
  XIcon,
} from "@/components/ui/icons"

import {
  Alert,
  AnimatedAlert,
  Badge,
  Button,
  SelectAllCheckbox,
  SkeletonRows,
  SortableTh,
  TableShell,
  cx,
} from "@/components/ui"
import { EmptyState } from "@/components/list"
import type { Student } from "@/types/classroom"
import { useQueryClient } from "@tanstack/react-query"
import type { RosterCsvProblem } from "@/domain/students"
import { useDismissFailedInvite } from "@/hooks/mutations/useDismissFailedInvite"
import { getErrorMessage } from "@/github-core/errorMessage"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useClassroomRoleContextOptional } from "@/context/classroomRole/ClassroomRoleProvider"
import { useIsOrgOwner } from "@/context/githubOrgRole/useIsOrgOwner"
import { useGitHubViewer } from "@/hooks/useGitHubResources"
import type { GitHubOrgInvitation } from "@/github-core/types"
import { invalidateInviteQueries as invalidateInviteQueriesForOrg } from "@/github-core/queries"
import { useUpdateRosterCache } from "@/hooks/useGetStudents"
import { useTeamRoster, useInvalidateTeamRoster } from "@/hooks/useTeamRoster"
import { useSyncRoster } from "@/hooks/mutations/useSyncRoster"
import { useRosterLastUpdated } from "@/hooks/useRosterLastUpdated"
import { useReinviteFailedInvite } from "@/hooks/mutations/useReinviteFailedInvite"
import type { SuppressedLogins } from "@/hooks/useSuppressedLogins"
import type { TeamRosterRow, ClassroomRole } from "@/util/teamRoster"
import {
  sortTeamRosterRows,
  sortTeamRosterRowsBy,
  type RosterTableSortColumn,
} from "@/util/teamRoster"
import { STAFF_ROLES } from "@/types/classroom"
import {
  ROLE_LABEL_KEY,
  canCancelInviteFor,
  canTargetForUnenroll,
  hasStudentEnrollment,
} from "@/util/classroomRoleUI"
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
} from "@/util/rowSelection"
import { useRangeSelection } from "@/hooks/useRangeSelection"
import RosterMemberModal from "@/pages/students/RosterMemberModal"
import AddStudentButtons from "@/pages/students/AddStudentButtons"
import RosterToolbar, {
  type RosterGrouping,
} from "@/pages/students/RosterToolbar"
import type { AddStudentActions } from "@/pages/students/RosterBulkActionsBar"
import type { StudentCsvRow } from "@/domain/students"
import { motion } from "motion/react"
import { blockEnter } from "@/lib/motion"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  groupStudentsBySection,
  groupStudentsByRole,
  nextSelectedKeyAfterSave,
  rosterSyncMessageKeys,
} from "./enrolledStudentsHelpers"
import { useRosterAutoSync } from "./useRosterAutoSync"
import { RosterRow } from "./RosterRow"
import { FailedInvitationsList } from "./FailedInvitationsList"
import { RosterParseProblems } from "./RosterParseProblems"
import { RosterWarnings } from "./RosterWarnings"

// One bar recipe per column: select, member, username, roles, actions. Loading
// starts with no rows, so the conditional Section and Status columns (present
// only when some row carries one) are never part of the skeleton.
const SKELETON_BARS = [
  "size-5",
  "h-4 w-40",
  "h-4 w-32",
  "h-6 w-20",
  "ms-auto h-4 w-4",
]

// One value per (column, direction) pair for the table-header sort controls.
type RosterTableSortValue =
  `${RosterTableSortColumn}-asc` | `${RosterTableSortColumn}-desc`

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
  // The on-entry classroom reconcile's live signal (null off-provider, e.g. in
  // isolated tests). Folded with the manual sync below into one `syncing` flag.
  const reconcilePending =
    useClassroomRoleContextOptional()?.reconcilePending ?? false
  const updateRosterCache = useUpdateRosterCache(org, classroom)
  const invalidateTeamRoster = useInvalidateTeamRoster(org, classroom)

  // Keyed by row.key so a clean action can't clobber another's warning.
  const [warnings, setWarnings] = useState<Record<string, string>>({})
  const [grouping, setGrouping] = useState<RosterGrouping>("none")
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all")
  const [sectionFilter, setSectionFilter] = useState<string>("all")
  // Header-driven column sort; null = the default order (enrollment state,
  // then name — see sortTeamRosterRows).
  const [tableSort, setTableSort] = useState<RosterTableSortValue | null>(null)
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
  const dismissFailedInvite = useDismissFailedInvite(org, classroom)

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
  // their student side and leaves the staff role intact — matching the row modal
  // in requiring hasStudentEnrollment, so a student+teacher is never silently
  // skipped by select-all.
  const isSelf = (row: TeamRosterRow) =>
    isSameGitHubUser(viewer ?? null, {
      github_id: row.github_id,
      username: row.username,
    })
  // Selectable for the bulk actions bar. The bar offers THREE actions (resend
  // invite, cancel invite, unenroll), so eligibility is per-action rather than
  // one unenroll-shaped gate: a pending email invite can't be unenrolled (the
  // roster matcher keys on username/github_id, so it would report "already
  // removed" while the row and the live invitation survive) but cancelling its
  // invitation is exactly the right bulk action. Gating selection on unenroll
  // alone made that path unreachable — and a class-sized email invite
  // un-bulk-cancellable.
  const isSelectable = (row: TeamRosterRow) =>
    !isSelf(row) &&
    hasStudentEnrollment(row) &&
    (canTargetForUnenroll(row) || canCancelInviteFor(row))

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

  // Role grouping earns its option only when the roster has more than plain
  // students to group — the same gate as the role filter options.
  const canGroupByRole = roleFilterOptions.some((r) => r !== "student")

  // Like effectiveRole/effectiveSection: a stale "group by role" selection
  // (the last staff row left) falls back to no grouping rather than leaving
  // the table grouped while the hidden select reads "No grouping".
  const effectiveGrouping =
    grouping === "role" && !canGroupByRole ? "none" : grouping

  // Text search over username/name/email + the status, role, and section
  // filters (see filterRosterRows — extracted so the facets are unit-tested).
  // Default order is enrollment state then name; an active header sort
  // re-orders by that column instead.
  const filtered = useMemo(() => {
    const base = sortTeamRosterRows(
      filterRosterRows(rows, {
        query,
        statusFilter,
        roleFilter: effectiveRole,
        sectionFilter: effectiveSection,
      }),
    )
    if (!tableSort) return base
    const [column, direction] = tableSort.split("-") as [
      RosterTableSortColumn,
      "asc" | "desc",
    ]
    return sortTeamRosterRowsBy(base, column, direction)
  }, [rows, query, statusFilter, effectiveRole, effectiveSection, tableSort])

  const hasSectionsInFiltered = useMemo(
    () => filtered.some((r) => r.section.trim()),
    [filtered],
  )

  // The grouped view of the filtered rows, or null for the flat table. Role
  // groups order teacher-first (each header matches its rows' leading role
  // chip); section groups sort by name with "No section" last. Rows inside a
  // group keep the toolbar's sort order.
  const groupedRows = useMemo(() => {
    if (effectiveGrouping === "role") {
      return groupStudentsByRole(filtered).map((g) => ({
        key: `role:${g.role}`,
        label: t(ROLE_LABEL_KEY[g.role]),
        rows: g.students,
      }))
    }
    if (effectiveGrouping === "section" && hasSectionsInFiltered) {
      return groupStudentsBySection(filtered).map((g) => ({
        key: `section:${g.section}`,
        label: g.section === NO_SECTION ? t("students.noSection") : g.section,
        rows: g.students,
      }))
    }
    return null
  }, [effectiveGrouping, filtered, hasSectionsInFiltered, t])

  const selected = useMemo(
    () => rows.find((row) => row.key === selectedKey) ?? null,
    [rows, selectedKey],
  )

  const selectedRows = useMemo(
    () => resolveSelectedRows(rows, selectedKeys, isSelectable, (r) => r.key),
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
    (r) => r.key,
  )
  const handleToggleSelectAll = () => {
    // Select-all only ever targets selectable (student-only) rows. When the
    // current view has rows but none are selectable — e.g., filtered to staff —
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
    setSelectedKeys((prev) =>
      toggleSelectAll(selectableFiltered, prev, (r) => r.key),
    )
  }

  // Grouping reorders rows into buckets, so a shift-range must span that
  // rendered order, not the flat filtered list.
  const renderedOrder = useMemo(
    () => (groupedRows ? groupedRows.flatMap((g) => g.rows) : filtered),
    [groupedRows, filtered],
  )

  // Shift-click range selection over the rendered order (grouping-aware), so a
  // shift-range fills the span the user actually sees.
  const { handleToggleRow, handleRowCheckboxClick } = useRangeSelection(
    renderedOrder,
    isSelectable,
    setSelectedKeys,
    (r) => r.key,
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

  // Explicit teacher-triggered CSV backfill (also auto-run on open). The hook
  // owns the roster-file invalidation that must always run; the toasts live
  // here so they skip when unmounted.
  const syncMutation = useSyncRoster(org, classroom)
  const runSync = () =>
    syncMutation.mutate(undefined, {
      onSuccess: (result) => {
        const parts = rosterSyncMessageKeys(result)
        notify({
          tone: "success",
          durationMs: 5000,
          message: result.noop
            ? t("students.syncUpToDate")
            : parts.length > 0
              ? parts.map((p) => t(p.key, { count: p.count })).join(" ")
              : t("students.syncRosterDone"),
        })
      },
      onError: (err) => {
        notify({
          tone: "error",
          message: t("students.syncFailed", { error: getErrorMessage(err) }),
        })
      },
    })

  // A roster synchronization is underway — the on-entry classroom reconcile,
  // the drift auto-sync, or the manual Sync button. While true the sync button
  // shows progress and the table below is inert: the sync rewrites the very
  // state (teams, invitations, roster.csv) these actions read and write.
  const syncing = reconcilePending || syncMutation.isPending

  // The Refresh caption's inputs: roster.csv's latest commit timestamp, and —
  // after a refresh completed this session — how many rows it touched (0 =
  // "no changes"). Both manual and drift auto-runs go through syncMutation.
  const lastUpdatedAt = useRosterLastUpdated(org, classroom)
  const lastSyncChanges =
    syncMutation.isSuccess && syncMutation.data
      ? syncMutation.data.noop
        ? 0
        : syncMutation.data.addedUsernames.length +
          syncMutation.data.recoveredEmails.length +
          syncMutation.data.removedEmails.length
      : null

  // Auto-sync on open (see useRosterAutoSync): append team members lacking a
  // CSV row when there's drift; the caller owns runSync (and its toasts, which
  // skip on unmount). Gated on the COMBINED syncing flag: the on-entry
  // reconcile already folds drift into its own commit, so starting a second
  // concurrent pass would only buy conflict retries.
  useRosterAutoSync({
    classroom,
    ready: !isLoading && !isError,
    csvMissingLogins,
    backfillNeededLogins,
    suppressedLogins,
    syncPending: syncing,
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
    // re-add the student the teacher just removed — e.g., when a best-effort
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

  // The Section column exists only when some row carries a section label —
  // derived from the status-independent sectionOptions so toggling a filter
  // can't add/remove a column mid-view. Status follows the same rule: a fully
  // enrolled roster has nothing to report there, so the column only appears
  // while some row is pending or needs attention (derived from ALL rows, so
  // filtering can't add/remove it mid-view either).
  const showSection = sectionOptions.length > 0
  const showStatus = useMemo(
    () => rows.some((r) => r.state !== "enrolled"),
    [rows],
  )
  const colCount = 5 + (showSection ? 1 : 0) + (showStatus ? 1 : 0)

  // The combined "Show" select folds the status and role filters into ONE
  // control (mirroring the submissions status select): picking a status
  // clears the role facet and vice versa. The two facets stay separate fields
  // for filterRosterRows — the select is just a consolidated view of them.
  const showValue =
    effectiveRole !== "all" ? `role:${effectiveRole}` : statusFilter
  const onShowChange = (value: string) => {
    if (value.startsWith("role:")) {
      setRoleFilter(value.slice("role:".length) as RoleFilter)
      setStatusFilter("all")
    } else {
      setStatusFilter(value as StatusFilter)
      setRoleFilter("all")
    }
  }

  // Active-filter split for the in-search-bar clear affordance ("Clear filter"
  // vs "Clear"), mirroring the submissions controls; clicking it resets query
  // and every filter (sort is a view preference, not a filter — kept).
  const hasFilterActive =
    statusFilter !== "all" ||
    effectiveRole !== "all" ||
    effectiveSection !== "all"
  const hasActiveFilter = hasFilterActive || query.trim() !== ""
  const clearAllFilters = () => {
    setQuery("")
    setStatusFilter("all")
    setRoleFilter("all")
    setSectionFilter("all")
  }

  const renderRow = (row: TeamRosterRow) => (
    <RosterRow
      key={row.key}
      row={row}
      selfRow={isSelf(row)}
      selectable={isSelectable(row)}
      checked={selectedKeys.has(row.key)}
      onOpen={setSelectedKey}
      onCheckboxClick={handleRowCheckboxClick}
      onToggle={handleToggleRow}
      showSection={showSection}
      showStatus={showStatus}
      disabled={syncing}
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
          <PaperAirplaneIcon aria-hidden="true" className="size-4 shrink-0" />
          {t("students.pendingBanner", { count: counts.pending })}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onShowChange("pending")}
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
            <XIcon aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </AnimatedAlert>

      {/* Non-owner: pending invites are owner-only. */}
      {!isLoading && !isError && pendingHidden ? (
        <Alert tone="error">
          <span className="text-sm">{t("students.pendingOwnerOnly")}</span>
        </Alert>
      ) : null}

      {/* Failed/expired invitations (owner-only). Frozen while a sync runs —
          this banner sits outside the locked table region, but Re-invite and
          Dismiss write the very invitations the sync is reconciling. */}
      {!isLoading && !isError && failedInvitations.length > 0 ? (
        <FailedInvitationsList
          failedInvitations={failedInvitations}
          actionsDisabled={
            syncing ||
            reinviteFailedInvite.isPending ||
            dismissFailedInvite.isPending
          }
          onReinvite={reinvite}
          onDismiss={(inv) =>
            dismissFailedInvite.mutate(
              {
                invitationId: inv.id,
                // Only an email-only invite has a metadata team to tear down.
                inviteEmail: inv.login ? undefined : inv.email,
              },
              {
                onError: (err) =>
                  notify({
                    tone: "error",
                    message: t("students.failedInviteDismissError", {
                      error: getErrorMessage(err),
                    }),
                  }),
              },
            )
          }
        />
      ) : null}

      {/* Toolbar: Sync leading on the left (mirroring the submissions
          toolbar's collect affordance) and doubling as the sync-in-progress
          indicator — label swaps to "Syncing…" while the on-entry reconcile,
          drift auto-sync, or a manual run is underway (the table below goes
          inert at the same time). The selection cluster (count + Actions +
          Clear) joins it on the left while rows are selected; search +
          filters + sort + add actions stay right-aligned like the submissions
          controls. */}
      {!isLoading && !isError && !isEmpty ? (
        <RosterToolbar
          org={org}
          classroom={classroom}
          client={client}
          syncing={syncing}
          lastUpdatedAt={lastUpdatedAt}
          lastSyncChanges={lastSyncChanges}
          onSync={() => {
            // Explicit backfill: clear the post-unenroll suppression so the
            // teacher's deliberate Sync always runs (re-adding any drifted
            // team members, even ones removed earlier this session).
            suppressedLogins.clear()
            runSync()
          }}
          selectedRows={selectedRows}
          onClearSelection={() => setSelectedKeys(new Set())}
          onBulkDone={onBulkDone}
          query={query}
          onQueryChange={setQuery}
          onClearAllFilters={clearAllFilters}
          hasActiveFilter={hasActiveFilter}
          hasFilterActive={hasFilterActive}
          showValue={showValue}
          onShowChange={onShowChange}
          statusOptions={statusOptions}
          roleFilterOptions={roleFilterOptions}
          canGroupByRole={canGroupByRole}
          sectionOptions={sectionOptions}
          effectiveSection={effectiveSection}
          onSectionChange={setSectionFilter}
          grouping={effectiveGrouping}
          onGroupingChange={setGrouping}
          addActions={addActions ?? null}
        />
      ) : null}

      {/* The roster table: Primer DataTable treatment via the shared
          TableShell frame (matching the assignments/submissions tables);
          select-all lives in the header row and the selection actions in the
          toolbar above. While a sync is underway the whole region is inert —
          `inert` blocks keyboard/focus wholesale (pointer-events/opacity are
          the visual half), and the row/select-all controls are also disabled
          so the freeze holds in DOMs that don't implement inert. A translucent
          skeleton shimmer overlays the dimmed rows so the freeze reads as
          "refreshing" rather than broken. */}
      <div
        aria-busy={syncing || undefined}
        inert={syncing || undefined}
        className={cx(
          "relative transition-opacity",
          syncing && "pointer-events-none opacity-60",
        )}
      >
        {syncing ? (
          <div
            aria-hidden="true"
            data-testid="roster-sync-veil"
            className="skeleton absolute inset-0 z-10 rounded-box opacity-40"
          />
        ) : null}
        <TableShell animate={false} padded ariaBusy={isLoading}>
          <caption className="sr-only">{t("students.table.caption")}</caption>
          <thead>
            <tr>
              <th scope="col" className="w-0">
                {/* Select-all lives in the select-column header (aligned above
                  the row checkboxes), replacing the old idle bulk bar. */}
                {!isLoading && !isError && !isEmpty ? (
                  <SelectAllCheckbox
                    className="align-middle"
                    ariaLabel={t("students.bulk.selectAll")}
                    disabled={syncing}
                    allSelected={allSelected}
                    someSelected={someSelected}
                    onToggle={handleToggleSelectAll}
                  />
                ) : (
                  <span className="sr-only">
                    {t("students.table.colSelect")}
                  </span>
                )}
              </th>
              {/* Sortable column headers — sorting lives here, not in the
                  toolbar. An inactive table falls back to the default order
                  (enrollment state, then name). */}
              <SortableTh
                label={t("students.table.colMember")}
                sort={tableSort ?? undefined}
                asc="member-asc"
                desc="member-desc"
                onSortChange={setTableSort}
              />
              <SortableTh
                label={t("students.table.colUsername")}
                sort={tableSort ?? undefined}
                asc="username-asc"
                desc="username-desc"
                onSortChange={setTableSort}
              />
              <SortableTh
                label={t("students.table.colRoles")}
                sort={tableSort ?? undefined}
                asc="role-asc"
                desc="role-desc"
                onSortChange={setTableSort}
              />
              {showSection ? (
                <SortableTh
                  label={t("students.table.colSection")}
                  sort={tableSort ?? undefined}
                  asc="section-asc"
                  desc="section-desc"
                  onSortChange={setTableSort}
                />
              ) : null}
              {showStatus ? (
                <SortableTh
                  label={t("students.table.colStatus")}
                  sort={tableSort ?? undefined}
                  asc="status-asc"
                  desc="status-desc"
                  onSortChange={setTableSort}
                />
              ) : null}
              <th scope="col" className="w-0">
                <span className="sr-only">
                  {t("students.table.colActions")}
                </span>
              </th>
            </tr>
          </thead>
          {isLoading ? (
            // Skeleton rows shaped like the loaded columns, so content fades
            // into place instead of jumping in to replace a centered spinner.
            <tbody>
              <SkeletonRows rows={5} bars={SKELETON_BARS} />
            </tbody>
          ) : isError ? (
            <tbody>
              <tr>
                <td colSpan={colCount} className="px-6 py-10 text-center">
                  <span
                    role="alert"
                    className="inline-flex items-center gap-2 text-sm text-error"
                  >
                    <AlertIcon aria-hidden="true" className="size-4 shrink-0" />
                    {t("students.rosterLoadError")}
                  </span>
                  <div className="mt-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => refetchRoster()}
                    >
                      {t("students.rosterRetry")}
                    </Button>
                  </div>
                </td>
              </tr>
            </tbody>
          ) : isEmpty ? (
            <tbody>
              <tr>
                <td colSpan={colCount}>
                  <EmptyState
                    variant="bare"
                    className="py-12"
                    icon={PeopleIcon}
                    titleAs="h3"
                    title={t("students.emptyTitle")}
                    body={t("students.emptyBody")}
                    action={
                      addActions ? (
                        <div className="flex flex-col items-center gap-3">
                          {/* The toolbar (and its syncing indicator) is hidden
                              on an empty roster, so say it here too. */}
                          {syncing ? (
                            <span
                              className="flex items-center gap-2 text-sm text-base-content/70"
                              aria-live="polite"
                            >
                              <SyncIcon
                                aria-hidden="true"
                                className="size-4 animate-spin"
                              />
                              {t("students.syncActive")}
                            </span>
                          ) : null}
                          <div className="flex justify-center gap-2">
                            <AddStudentButtons
                              addActions={addActions}
                              disabled={syncing}
                            />
                          </div>
                        </div>
                      ) : null
                    }
                  />
                </td>
              </tr>
            </tbody>
          ) : filtered.length === 0 ? (
            <tbody>
              <tr>
                <td colSpan={colCount}>
                  <EmptyState
                    variant="bare"
                    body={
                      query.trim()
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
                                statusOptions.find(
                                  (o) => o.value === statusFilter,
                                )?.label ?? statusFilter,
                            })
                    }
                  />
                </td>
              </tr>
            </tbody>
          ) : groupedRows ? (
            // One <tbody> per group (role or section), opened by a full-width
            // rowgroup header — the table equivalent of the old
            // section-divider list headers.
            groupedRows.map(({ key, label, rows: group }) => (
              <motion.tbody
                key={key}
                variants={blockEnter}
                initial="initial"
                animate="animate"
              >
                <tr className="bg-base-200/60">
                  <th
                    scope="rowgroup"
                    colSpan={colCount}
                    className="py-2 text-sm font-semibold text-base-content/70"
                  >
                    <div className="flex items-center justify-between">
                      {label}
                      <Badge ghost>{group.length}</Badge>
                    </div>
                  </th>
                </tr>
                {group.map((row) => renderRow(row))}
              </motion.tbody>
            ))
          ) : (
            <motion.tbody
              variants={blockEnter}
              initial="initial"
              animate="animate"
            >
              {filtered.map((row) => renderRow(row))}
            </motion.tbody>
          )}
        </TableShell>
      </div>

      <RosterMemberModal
        open={Boolean(selected)}
        org={org}
        classroom={classroom}
        teamSlugByRole={teamSlugByRole}
        row={selected}
        canManage={isOwner}
        frozen={syncing}
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
