import { useCallback, useMemo, useState } from "react"
import { TableEmptyRow } from "@/components/list"
import { Trans, useTranslation } from "react-i18next"
import { useParams } from "@tanstack/react-router"
import {
  ChevronRightIcon,
  FilterIcon,
  LinkExternalIcon,
  PersonAddIcon,
} from "@/components/ui/icons"

import {
  Alert,
  AnimatedAlert,
  Button,
  Checkbox,
  rtlFlip,
  SelectAllCheckbox,
  SelectSeparatorOption,
  SkeletonRows,
  SortableTh,
  TableErrorRow,
  TableShell,
  Toolbar,
} from "@/components/ui"
import PageShell from "@/components/PageShell"
import PageHeader, { OrgLink } from "@/components/PageHeader"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import RequireRole from "@/components/RequireRole"
import Avatar from "@/components/avatar"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useGitHubViewer } from "@/hooks/useGitHubResources"
import useOrgMembersOverview from "@/hooks/useOrgMembersOverview"
import {
  filterOrgMemberRows,
  sortOrgMemberRowsBy,
  type OrgMemberRow,
  type OrgMembersRoleFilter,
  type OrgMembersSortColumn,
  type OrgMembersStatusFilter,
} from "@/util/orgMembers"
import { githubOrgPeopleUrl } from "@/util/orgUrl"
import { isSameGitHubUser } from "@/util/students"
import { motion } from "motion/react"
import { blockEnter } from "@/lib/motion"
import { ClickableTr } from "@/lib/motionComponents"
import BulkActionsBar, {
  type BulkDoneInput,
} from "@/pages/orgMembers/BulkActionsBar"
import MemberDetailModal from "@/pages/orgMembers/MemberDetailModal"
import OrphanedInvitationsNotice from "@/pages/orgMembers/OrphanedInvitationsNotice"
import { useDismissFailedInvitations } from "@/hooks/mutations/useDismissFailedInvitations"
import { useRowSelection } from "@/hooks/useRowSelection"
import { useOrgMembersCacheSync } from "@/hooks/useOrgMembersCacheSync"
import {
  GitHubIdentity,
  MemberStatusBadge,
  OrgRoleBadge,
  initialsFor,
  runInviteMember,
} from "@/pages/orgMembers/memberPresentation"
import useGetClasses from "@/hooks/useGetClasses"
import { matchesQuery } from "@/util/textMatch"

// Sentinel classroom-filter value for "members on no roster". A real classroom
// path can't collide (paths don't contain a leading colon).
const NO_CLASSROOM_FILTER = ":none:"

// One bar recipe per column: select, name, username, classrooms, roles,
// status, actions.
const SKELETON_BARS = [
  "size-5",
  "h-4 w-36",
  "h-4 w-28",
  "h-4 w-20",
  "h-6 w-20",
  "h-6 w-24",
  "ms-auto h-4 w-4",
]

const MEMBERS_COL_COUNT = SKELETON_BARS.length

const rowKey = (row: OrgMemberRow) => row.key

// One value per (column, direction) pair for the table-header sort controls.
type MembersTableSortValue =
  `${OrgMembersSortColumn}-asc` | `${OrgMembersSortColumn}-desc`

const OrgMembersPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.members"))
  const { org } = useParams({ strict: false })
  const client = useGitHubClient()
  const { notify } = useToast()
  const { data: viewer } = useGitHubViewer()
  const {
    rows,
    members,
    ownerIds,
    isLoading,
    isError,
    refetchMembers,
    teamSlugByClassroom,
    displayNameByClassroom,
    notes,
    orphanedFailedInvitations,
  } = useOrgMembersOverview(org)
  const { classes } = useGetClasses(org)
  const [query, setQuery] = useState("")
  // Classroom filter: "" = all, NO_CLASSROOM_FILTER = members on no roster,
  // else a classroom path. Applied on top of the text search.
  const [classroomFilter, setClassroomFilter] = useState("")
  // The combined "Show" select's facets (status + org role), mirroring the
  // roster toolbar's consolidated filter.
  const [statusFilter, setStatusFilter] =
    useState<OrgMembersStatusFilter>("all")
  const [roleFilter, setRoleFilter] = useState<OrgMembersRoleFilter>("all")
  // Header-driven column sort; null = the default order (classification, then
  // name — see aggregateOrgMembers).
  const [tableSort, setTableSort] = useState<MembersTableSortValue | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [invitingKey, setInvitingKey] = useState<string | null>(null)
  const cacheSync = useOrgMembersCacheSync(org, teamSlugByClassroom)

  // After an org-level removal: the hook seeds/reconciles the caches; the page
  // drops the stale selection key, or the vanished row keeps the toolbar stuck
  // at "N selected" with no visible checkbox to clear.
  const refresh = (
    affected: OrgMemberRow,
    removed: boolean,
    unenrolledClassrooms: string[],
  ) => {
    cacheSync.afterMemberRemoval(affected, removed, unenrolledClassrooms)
    if (removed) deselectRow(affected.key)
  }

  const refreshInvite = cacheSync.afterInvite

  const handleBulkDone = (input: BulkDoneInput) => {
    cacheSync.afterBulkRun(input, rows)
    clearSelection()
  }

  // Dismiss GitHub's orphaned failed-invitation records (see the notice). The
  // hook owns the invalidation; the outcome toast lives here so it skips when
  // the page has unmounted.
  const dismissFailedInvitations = useDismissFailedInvitations(org ?? "")
  const dismissOrphans = (invitationIds: number[]) => {
    if (invitationIds.length === 0) return
    dismissFailedInvitations.mutate(invitationIds, {
      onSuccess: (result) => {
        const cleared = result.dismissed + result.alreadyGone
        if (result.failed.length > 0) {
          notify({
            tone: "error",
            message: t("orgMembers.orphanedInvitesDismissFailed", {
              count: result.failed.length,
              error: result.failed[0]!.message,
            }),
          })
        }
        if (cleared > 0) {
          notify({
            tone: "success",
            message: t("orgMembers.orphanedInvitesDismissed", {
              count: cleared,
            }),
          })
        }
      },
      onError: (err) =>
        notify({
          tone: "error",
          message: t("orgMembers.orphanedInvitesDismissFailed", {
            count: invitationIds.length,
            error: err instanceof Error ? err.message : String(err),
          }),
        }),
    })
  }

  // Inline row invite for an on-roster non-member (mirrors the detail-drawer
  // action). Invites by github_id so a stale username doesn't matter.
  // Feedback stays a toast for this caller: a dense table row has no inline
  // slot, and the success must outlive the eventually-consistent refetch.
  const handleQuickInvite = async (row: OrgMemberRow) => {
    if (!org || invitingKey) return
    setInvitingKey(row.key)
    try {
      await runInviteMember(
        client,
        org,
        row,
        {
          onSuccess: (message) =>
            notify({ tone: "success", durationMs: 6000, message }),
          onError: (message) => notify({ tone: "error", message }),
        },
        () => refreshInvite(),
        t,
      )
    } finally {
      setInvitingKey(null)
    }
  }

  const isSelf = useCallback(
    (row: OrgMemberRow) =>
      isSameGitHubUser(viewer ?? null, {
        github_id: row.github_id,
        username: row.username,
      }),
    [viewer],
  )

  // An org owner/admin: in the fetched admin-id set, or the signed-in account
  // (always an owner here — page is owner-gated — even if the admin list
  // couldn't be read).
  const isOwner = (row: OrgMemberRow) =>
    (Boolean(row.github_id) && ownerIds.has(row.github_id)) || isSelf(row)

  const filtered = useMemo(() => {
    const base = filterOrgMemberRows(
      rows.filter((row) => {
        if (!matchesQuery(query, row.username, row.name, row.email)) {
          return false
        }
        // Classroom filter: all / no-classroom / a specific classroom.
        if (classroomFilter === NO_CLASSROOM_FILTER) {
          return row.classrooms.length === 0
        }
        if (classroomFilter) {
          return row.classrooms.some((c) => c.classroom === classroomFilter)
        }
        return true
      }),
      { statusFilter, roleFilter, isOwner },
    )
    if (!tableSort) return base
    const [column, direction] = tableSort.split("-") as [
      OrgMembersSortColumn,
      "asc" | "desc",
    ]
    return sortOrgMemberRowsBy(base, column, direction, isOwner)
    // isSelf/isOwner depend on viewer + ownerIds; recompute when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    rows,
    query,
    classroomFilter,
    statusFilter,
    roleFilter,
    tableSort,
    viewer,
    ownerIds,
  ])

  // The combined "Show" select folds both facets into one control (the roster
  // recipe): picking a status clears the role facet and vice versa.
  const showValue = roleFilter !== "all" ? `role:${roleFilter}` : statusFilter
  const onShowChange = (value: string) => {
    if (value.startsWith("role:")) {
      setRoleFilter(value.slice("role:".length) as OrgMembersRoleFilter)
      setStatusFilter("all")
    } else {
      setStatusFilter(value as OrgMembersStatusFilter)
      setRoleFilter("all")
    }
  }

  // The in-search-bar clear affordance ("Clear filter" vs "Clear"); clicking
  // resets query + filters (sort is a view preference, kept).
  const hasFilterActive =
    classroomFilter !== "" || statusFilter !== "all" || roleFilter !== "all"
  const hasActiveFilter = hasFilterActive || query.trim() !== ""
  const clearAllFilters = () => {
    setQuery("")
    setClassroomFilter("")
    setStatusFilter("all")
    setRoleFilter("all")
  }

  const selected = useMemo(
    () => rows.find((row) => row.key === selectedKey) ?? null,
    [rows, selectedKey],
  )
  const discrepancyCount = useMemo(
    () =>
      rows.filter((row) => row.classification === "on-roster-not-member")
        .length,
    [rows],
  )

  // The signed-in owner can't be bulk-added/removed — a row is selectable only
  // when it isn't self. Stable per viewer so the selection memos key on it.
  const isSelectable = useCallback(
    (row: OrgMemberRow) => !isSelf(row),
    [isSelf],
  )

  // Multi-select for bulk classroom actions. Selection is by row key and
  // persists across search filtering (a hidden-but-selected row is still acted
  // on); "select all" targets the currently-filtered rows. OrgMembersPage
  // renders `filtered` flat (no grouping), so it is also the rendered order.
  const {
    selectedKeys,
    selectedRows,
    allSelected: allFilteredSelected,
    someSelected: someFilteredSelected,
    toggleSelectAll: handleToggleSelectAll,
    deselect: deselectRow,
    clear: clearSelection,
    handleToggleRow,
    handleRowCheckboxClick,
  } = useRowSelection({
    rows,
    filtered,
    isSelectable,
    keyOf: rowKey,
  })

  // Picker/filter options: the display name from classroom.json when its
  // metadata has loaded, else the directory slug.
  const classroomOptions = useMemo(
    () =>
      classes.map((c) => ({
        name: displayNameByClassroom.get(c.path) ?? c.name,
        path: c.path,
      })),
    [classes, displayNameByClassroom],
  )

  return (
    <>
      <PageShell>
        <RequireRole allow="owner">
          <PageHeader
            title={t("orgMembers.heading")}
            subtitle={
              <>
                <Trans
                  i18nKey="orgMembers.subtitle"
                  values={{ org: org ?? "" }}
                  components={{
                    orgLink: (
                      <OrgLink
                        org={org}
                        href={githubOrgPeopleUrl(org ?? "")}
                        title={t("common.openOrgOnGitHub", { org })}
                      />
                    ),
                  }}
                />
                {org && (
                  <a
                    href={githubOrgPeopleUrl(org)}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 flex w-fit items-center gap-1 text-sm text-primary hover:underline"
                  >
                    <LinkExternalIcon aria-hidden="true" className="size-4" />
                    {t("orgMembers.manageMembersOnGitHub")}
                  </a>
                )}
              </>
            }
          />

          {/* Always-on scope warning: a shared org lists other teachers'
              members and students too, so say so before the destructive
              member actions below. */}
          <Alert tone="warning" className="mt-6 text-sm">
            <span>{t("orgMembers.sharedOrgNotice", { org })}</span>
          </Alert>

          <AnimatedAlert
            tone="warning"
            show={notes.length > 0}
            className="mt-6 text-sm"
            role="status"
          >
            <span>{notes.join(" ")}</span>
          </AnimatedAlert>

          {orphanedFailedInvitations.length > 0 ? (
            <div className="mt-6">
              <OrphanedInvitationsNotice
                orphans={orphanedFailedInvitations}
                busy={dismissFailedInvitations.isPending}
                onDismiss={(id) => dismissOrphans([id])}
                onDismissAll={() =>
                  dismissOrphans(
                    orphanedFailedInvitations.map((o) => o.invitation.id),
                  )
                }
              />
            </div>
          ) : null}

          <AnimatedAlert
            tone="error"
            show={discrepancyCount > 0}
            className="mt-6 text-sm"
            role="status"
          >
            <span>
              {t("orgMembers.discrepancy", { count: discrepancyCount })}
            </span>
          </AnimatedAlert>

          {/* One toolbar row (the roster/submissions recipe): member count —
              swapped for the selection cluster while rows are selected — on
              the left; search + filters right-aligned. */}
          <Toolbar className="mt-6">
            {selectedKeys.size === 0 && !isLoading && !isError ? (
              <span className="text-sm text-base-content/60 tabular-nums">
                {t("orgMembers.bulk.memberCount", { count: filtered.length })}
              </span>
            ) : null}
            {org ? (
              <BulkActionsBar
                org={org}
                selectedRows={selectedRows}
                members={members}
                classrooms={classroomOptions}
                isOwner={isOwner}
                onClearSelection={clearSelection}
                onDone={handleBulkDone}
              />
            ) : null}
            <Toolbar.Trailing>
              <Toolbar.Search
                // Wide enough for the full placeholder; the classroom filter
                // next door stays compact in trade.
                className="min-w-[15rem] flex-1 sm:min-w-[21rem] sm:max-w-lg"
                placeholder={t("orgMembers.searchPlaceholder")}
                ariaLabel={t("orgMembers.searchLabel")}
                value={query}
                onChange={setQuery}
                onClear={clearAllFilters}
                clearActive={hasActiveFilter}
                hasFilterActive={hasFilterActive}
              />
              {/* One combined "Show" select: statuses, then the org-role
                  group — mirroring the roster toolbar's consolidated filter. */}
              <Toolbar.FilterSelect
                icon={<FilterIcon aria-hidden="true" className="size-4" />}
                active={showValue !== "all"}
                aria-label={t("orgMembers.filterShowLabel")}
                value={showValue}
                onChange={(e) => onShowChange(e.target.value)}
              >
                <option value="all">{t("orgMembers.filterAll")}</option>
                <option value="not-in-org">
                  {t("orgMembers.filterNotInOrg")}
                </option>
                <option value="invitation-pending">
                  {t("orgMembers.filterInvitationPending")}
                </option>
                <option value="not-enrolled">
                  {t("orgMembers.filterNotEnrolled")}
                </option>
                <SelectSeparatorOption />
                <option value="role:owner">
                  {t("orgMembers.filterOwners")}
                </option>
                <option value="role:member">
                  {t("orgMembers.filterMembers")}
                </option>
              </Toolbar.FilterSelect>
              <Toolbar.FilterSelect
                icon={<FilterIcon aria-hidden="true" className="size-4" />}
                active={classroomFilter !== ""}
                // Compact control; long classroom names live in the popup,
                // which sizes to its options.
                className="min-w-[10rem]"
                aria-label={t("orgMembers.filterByClassroomLabel")}
                value={classroomFilter}
                onChange={(e) => setClassroomFilter(e.target.value)}
              >
                <option value="">{t("orgMembers.filterAllClassrooms")}</option>
                <option value={NO_CLASSROOM_FILTER}>
                  {t("orgMembers.filterNoClassroom")}
                </option>
                {classroomOptions.map((c) => (
                  <option key={c.path} value={c.path}>
                    {c.name}
                  </option>
                ))}
              </Toolbar.FilterSelect>
            </Toolbar.Trailing>
          </Toolbar>

          {/* The shared TableShell recipe (roster/assignments tables):
              select-all in the select-column header, selection actions in the
              toolbar above. */}
          <div className="mt-4">
            <TableShell animate={false} padded ariaBusy={isLoading}>
              <caption className="sr-only">
                {t("orgMembers.table.caption")}
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="w-0">
                    {!isLoading && !isError && filtered.length > 0 ? (
                      <SelectAllCheckbox
                        className="align-middle"
                        ariaLabel={t("orgMembers.bulk.selectAll")}
                        allSelected={allFilteredSelected}
                        someSelected={someFilteredSelected}
                        onToggle={handleToggleSelectAll}
                      />
                    ) : (
                      <span className="sr-only">
                        {t("orgMembers.table.colSelect")}
                      </span>
                    )}
                  </th>
                  {/* Sortable column headers — an inactive table falls back
                      to the default order (classification, then name). */}
                  <SortableTh
                    label={t("orgMembers.table.colName")}
                    sort={tableSort ?? undefined}
                    asc="name-asc"
                    desc="name-desc"
                    onSortChange={setTableSort}
                  />
                  <SortableTh
                    label={t("orgMembers.table.colUsername")}
                    sort={tableSort ?? undefined}
                    asc="username-asc"
                    desc="username-desc"
                    onSortChange={setTableSort}
                  />
                  <SortableTh
                    className="hidden sm:table-cell"
                    label={t("orgMembers.table.colClassrooms")}
                    sort={tableSort ?? undefined}
                    asc="classrooms-asc"
                    desc="classrooms-desc"
                    onSortChange={setTableSort}
                  />
                  <SortableTh
                    label={t("orgMembers.table.colRoles")}
                    sort={tableSort ?? undefined}
                    asc="role-asc"
                    desc="role-desc"
                    onSortChange={setTableSort}
                  />
                  <SortableTh
                    label={t("orgMembers.table.colStatus")}
                    sort={tableSort ?? undefined}
                    asc="status-asc"
                    desc="status-desc"
                    onSortChange={setTableSort}
                  />
                  <th scope="col" className="w-0">
                    <span className="sr-only">
                      {t("orgMembers.table.colActions")}
                    </span>
                  </th>
                </tr>
              </thead>
              {/* Same recipe as the assignments table: the body enters as one
                  block and replays on data arrival / filter changes (not per
                  search keystroke). */}
              <motion.tbody
                key={`${isLoading}:${classroomFilter}:${statusFilter}:${roleFilter}`}
                variants={blockEnter}
                initial="initial"
                animate="animate"
              >
                {isLoading && <SkeletonRows rows={6} bars={SKELETON_BARS} />}
                {!isLoading && isError && (
                  <TableErrorRow
                    colSpan={MEMBERS_COL_COUNT}
                    message={t("orgMembers.loadError")}
                    retryLabel={t("orgMembers.retry")}
                    onRetry={refetchMembers}
                  />
                )}
                {!isLoading && !isError && filtered.length === 0 && (
                  <TableEmptyRow
                    colSpan={MEMBERS_COL_COUNT}
                    body={
                      classroomFilter === NO_CLASSROOM_FILTER
                        ? t("orgMembers.noMembersNoClassroom")
                        : classroomFilter
                          ? t("orgMembers.noMembersInClassroom", {
                              classroom:
                                classroomOptions.find(
                                  (c) => c.path === classroomFilter,
                                )?.name ?? classroomFilter,
                            })
                          : t("orgMembers.noMatch")
                    }
                  />
                )}
                {!isLoading &&
                  !isError &&
                  filtered.map((row) => (
                    <ClickableTr
                      key={row.key}
                      className="group/row hover:bg-base-200"
                      onClick={() => setSelectedKey(row.key)}
                    >
                      <td className="w-0">
                        <Checkbox
                          className="size-6"
                          aria-label={
                            isSelf(row)
                              ? t("orgMembers.bulk.selfNotSelectable")
                              : t("orgMembers.bulk.selectRow", {
                                  label: row.username || row.email || row.name,
                                })
                          }
                          // aria-disabled + click guard instead of `disabled`:
                          // the checkbox stays focusable so the "you can't
                          // select yourself" reason reaches keyboard and
                          // screen-reader users.
                          aria-disabled={isSelf(row) || undefined}
                          title={
                            isSelf(row)
                              ? t("orgMembers.bulk.selfNotSelectable")
                              : undefined
                          }
                          checked={selectedKeys.has(row.key)}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (isSelf(row)) {
                              e.preventDefault()
                              return
                            }
                            handleRowCheckboxClick(e, row.key)
                          }}
                          onChange={() => {
                            if (isSelf(row)) return
                            handleToggleRow(row.key)
                          }}
                        />
                      </td>
                      <td className="min-w-0">
                        <Avatar
                          name={row.name || row.username || row.email}
                          github={row.username}
                          initials={initialsFor(row)}
                          onClick={() => setSelectedKey(row.key)}
                        />
                      </td>
                      <td>
                        {/* Bare handle — the octocat + numeric id live in
                            the member detail modal. */}
                        <GitHubIdentity row={row} bare />
                      </td>
                      <td className="hidden whitespace-nowrap text-xs text-base-content/70 sm:table-cell">
                        {t("orgMembers.classroomCount", {
                          count: row.classrooms.length,
                        })}
                      </td>
                      <td>
                        <OrgRoleBadge row={row} isOwner={isOwner(row)} />
                      </td>
                      <td>
                        <MemberStatusBadge row={row} />
                      </td>
                      <td className="w-0 ps-2">
                        <div className="flex items-center justify-end gap-3">
                          {row.classification === "on-roster-not-member" &&
                          row.github_id ? (
                            <Button
                              variant="primary"
                              size="xs"
                              loading={invitingKey === row.key}
                              disabled={invitingKey === row.key}
                              onClick={(e) => {
                                e.stopPropagation()
                                void handleQuickInvite(row)
                              }}
                            >
                              {invitingKey === row.key ? null : (
                                <>
                                  <PersonAddIcon
                                    aria-hidden="true"
                                    className="size-4"
                                  />
                                  {t("orgMembers.invite")}
                                </>
                              )}
                            </Button>
                          ) : null}
                          <ChevronRightIcon
                            aria-hidden="true"
                            className={`size-4 text-base-content/30 transition-transform duration-150 ltr:group-hover/row:translate-x-0.5 rtl:group-hover/row:-translate-x-0.5 group-hover/row:text-base-content/70 ${rtlFlip}`}
                          />
                        </div>
                      </td>
                    </ClickableTr>
                  ))}
              </motion.tbody>
            </TableShell>
          </div>
        </RequireRole>
      </PageShell>

      {org ? (
        <MemberDetailModal
          open={Boolean(selected)}
          org={org}
          row={selected}
          isSelf={selected ? isSelf(selected) : false}
          isOwner={selected ? isOwner(selected) : false}
          onClose={() => setSelectedKey(null)}
          onRemoved={(removed, unenrolledClassrooms) => {
            const affected = selected
            setSelectedKey(null)
            if (affected) refresh(affected, removed, unenrolledClassrooms)
          }}
          onInvited={() => {
            setSelectedKey(null)
            refreshInvite()
          }}
        />
      ) : null}
    </>
  )
}

export default OrgMembersPage
