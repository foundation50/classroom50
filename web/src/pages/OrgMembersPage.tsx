import { useMemo, useState } from "react"
import { EmptyState } from "@/components/list"
import { Trans, useTranslation } from "react-i18next"
import { useParams } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import {
  AlertIcon,
  ChevronRightIcon,
  FilterIcon,
  LinkExternalIcon,
  PersonAddIcon,
} from "@/components/ui/icons"

import {
  AnimatedAlert,
  Badge,
  Button,
  SelectAllCheckbox,
  SkeletonRows,
  SortableTh,
  TableShell,
  Toolbar,
  rtlFlip,
} from "@/components/ui"
import PageShell from "@/components/PageShell"
import PageHeader, { OrgLink } from "@/components/PageHeader"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import RequireRole from "@/components/RequireRole"
import Avatar from "@/components/avatar"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useGitHubViewer } from "@/hooks/useGitHubResources"
import { githubKeys, invalidateInviteQueries } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"
import { classroomTeamSlug } from "@/util/teamSlug"
import useOrgMembersOverview from "@/hooks/useOrgMembersOverview"
import {
  sortOrgMemberRowsBy,
  type OrgMemberRow,
  type OrgMembersSortColumn,
} from "@/util/orgMembers"
import { githubOrgPeopleUrl } from "@/util/orgUrl"
import type { StudentCsvRow } from "@/domain/students"
import type { GitHubUser } from "@/github-core/types"
import { isSameGitHubUser } from "@/util/students"
import { motion } from "motion/react"
import { blockEnter } from "@/lib/motion"
import { ClickableTr } from "@/lib/motionComponents"
import BulkActionsBar, {
  type BulkDoneInput,
} from "@/pages/orgMembers/BulkActionsBar"
import MemberDetailModal from "@/pages/orgMembers/MemberDetailModal"
import {
  resolveSelectedRows,
  selectableRows,
  selectAllState,
  toggleSelectAll,
} from "@/pages/orgMembers/selection"
import { useRangeSelection } from "@/pages/orgMembers/useRangeSelection"
import {
  ClassificationBadge,
  GitHubIdentity,
  initialsFor,
  runInviteMember,
} from "@/pages/orgMembers/memberPresentation"
import useGetClasses from "@/hooks/useGetClasses"
import { rosterPath } from "@/util/rosterPath"

// Delay before reconciling an optimistically-updated roster.csv cache with
// the authoritative GitHub read: the contents API lags a fresh commit, so an
// immediate refetch reads the pre-commit file and reverts the optimistic change.
const CSV_RECONCILE_DELAY_MS = 4000

// Sentinel classroom-filter value for "members on no roster". A real classroom
// path can't collide (paths don't contain a leading colon).
const NO_CLASSROOM_FILTER = ":none:"

// One bar recipe per column: select, member, classrooms, status, actions.
const SKELETON_BARS = [
  "size-5",
  "h-4 w-40",
  "h-4 w-24",
  "h-6 w-28",
  "ms-auto h-4 w-4",
]

const MEMBERS_COL_COUNT = SKELETON_BARS.length

// One value per (column, direction) pair for the table-header sort controls.
type MembersTableSortValue =
  `${OrgMembersSortColumn}-asc` | `${OrgMembersSortColumn}-desc`

const OrgMembersPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.members"))
  const { org } = useParams({ strict: false })
  const client = useGitHubClient()
  const { notify } = useToast()
  const queryClient = useQueryClient()
  const { data: viewer } = useGitHubViewer()
  const {
    rows,
    members,
    ownerIds,
    isLoading,
    isError,
    teamSlugByClassroom,
    notes,
  } = useOrgMembersOverview(org)
  const { classes } = useGetClasses(org)
  const [query, setQuery] = useState("")
  // Classroom filter: "" = all, NO_CLASSROOM_FILTER = members on no roster,
  // else a classroom path. Applied on top of the text search.
  const [classroomFilter, setClassroomFilter] = useState("")
  // Header-driven column sort; null = the default order (classification, then
  // name — see aggregateOrgMembers).
  const [tableSort, setTableSort] = useState<MembersTableSortValue | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [invitingKey, setInvitingKey] = useState<string | null>(null)
  // Multi-select for bulk classroom actions. Selection is by row key and
  // persists across search filtering (a hidden-but-selected row is still acted
  // on); "select all" targets the currently-filtered rows.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())

  // Refresh after an org-level member removal (unenrolls from every classroom +
  // removes org membership). Optimistically drop them from each affected
  // classroom's CSV + team caches together (no false "unprovisioned" flash),
  // then reconcile with the server on a delay.
  const refresh = (affected?: OrgMemberRow) => {
    if (!org) return
    queryClient.invalidateQueries({ queryKey: githubKeys.orgMembersAll(org) })
    invalidateInviteQueries(queryClient, org)
    for (const access of affected?.classrooms ?? []) {
      optimisticRemove(access.classroom, [affected!])
      invalidateClassroom(access.classroom, { skipCsv: true })
      scheduleClassroomReconcile(access.classroom)
    }
  }

  // Refresh after an org invite (only org-invite state changed). Just re-read
  // the members + invite lists.
  const refreshInvite = () => {
    if (!org) return
    queryClient.invalidateQueries({ queryKey: githubKeys.orgMembersAll(org) })
    invalidateInviteQueries(queryClient, org)
  }

  // Resolved GitHub team slug for a classroom (classroom.json.team.slug, else
  // the derived classroomTeamSlug). Must match the key
  // useOrgMembersOverview reads the team cache under, or optimistic writes below
  // target a cache nobody reads (a name-collision classroom's real slug differs
  // from the heuristic) and reintroduce the false "unprovisioned" flash.
  const teamSlugFor = (classroom: string) =>
    teamSlugByClassroom.get(classroom) ?? classroomTeamSlug(classroom)

  // Invalidate the non-racy caches a roster write touches: classroom.json and,
  // unless suppressed, the CSV. The team-members query is deliberately NOT
  // invalidated here — it's handled by the optimistic seed + delayed reconcile,
  // because invalidating CSV and team at different beats lets aggregateOrgMembers
  // compare a fresh team against a stale CSV and flash a false "unprovisioned"
  // state. `skipCsv` is set after we've optimistically seeded the CSV
  // (invalidating it would refetch the pre-commit file and revert the seed).
  const invalidateClassroom = (
    classroom: string,
    opts?: { skipCsv?: boolean },
  ) => {
    if (!org) return
    if (!opts?.skipCsv) {
      queryClient.invalidateQueries({
        queryKey: githubKeys.csvFile(org, CONFIG_REPO, rosterPath(classroom)),
      })
    }
    queryClient.invalidateQueries({
      queryKey: githubKeys.jsonFile(
        org,
        CONFIG_REPO,
        `${classroom}/classroom.json`,
      ),
    })
  }

  // Optimistically drop members (by resolved id/login) from BOTH the target
  // classroom's roster.csv AND its team-members cache, in the same tick, so
  // the two never disagree (which would flash a false "unprovisioned" state).
  // teamSlug is the resolved slug, so a collided-name classroom updates right.
  const optimisticRemove = (classroom: string, removed: OrgMemberRow[]) => {
    if (!org || removed.length === 0) return
    const ids = new Set(removed.map((r) => r.github_id?.trim()).filter(Boolean))
    const logins = new Set(
      removed.map((r) => r.username?.trim().toLowerCase()).filter(Boolean),
    )
    queryClient.setQueryData<StudentCsvRow[]>(
      githubKeys.csvFile(org, CONFIG_REPO, rosterPath(classroom)),
      (current) =>
        current?.filter(
          (s) =>
            !(s.github_id && ids.has(s.github_id.trim())) &&
            !(s.username && logins.has(s.username.trim().toLowerCase())),
        ) ?? current,
    )
    queryClient.setQueryData<GitHubUser[]>(
      githubKeys.teamMembers(org, teamSlugFor(classroom)),
      (current) =>
        current?.filter(
          (m) => !ids.has(String(m.id)) && !logins.has(m.login.toLowerCase()),
        ) ?? current,
    )
  }

  // Reconcile a classroom's CSV + team caches with the server once GitHub's
  // APIs have caught up with the commit (both lag). Done on one delayed tick so
  // they refetch together and can't flash an inconsistent intermediate state.
  const scheduleClassroomReconcile = (classroom: string) => {
    if (!org) return
    window.setTimeout(() => {
      queryClient.invalidateQueries({
        queryKey: githubKeys.csvFile(org, CONFIG_REPO, rosterPath(classroom)),
      })
      queryClient.invalidateQueries({
        queryKey: githubKeys.teamMembers(org, teamSlugFor(classroom)),
      })
    }, CSV_RECONCILE_DELAY_MS)
  }

  // After a bulk add/remove: optimistically reflect the change in the CSV +
  // team caches the row status derives from (kept consistent, no false
  // "unprovisioned" flash), then reconcile both with the server on a delay.
  // An org-wide removal touches EVERY classroom the removed members belonged
  // to, so it seeds and reconciles each of them (the per-row refresh() logic,
  // batched).
  const handleBulkDone = (input: BulkDoneInput) => {
    if (!org) return

    if (input.action === "remove-org") {
      const removedRows = rows.filter((r) => input.affectedKeys.includes(r.key))
      // Archived classrooms are excluded: removeMemberFromOrg can't unenroll
      // them, so their rosters really do still list the student.
      const affectedClassrooms = new Set(
        removedRows.flatMap((r) =>
          r.classrooms.filter((c) => !c.archived).map((c) => c.classroom),
        ),
      )
      for (const classroom of affectedClassrooms) {
        optimisticRemove(classroom, removedRows)
        invalidateClassroom(classroom, { skipCsv: true })
        scheduleClassroomReconcile(classroom)
      }
      queryClient.invalidateQueries({ queryKey: githubKeys.orgMembersAll(org) })
      invalidateInviteQueries(queryClient, org)
      setSelectedKeys(new Set())
      return
    }

    const { classroom, affectedKeys } = input

    if (input.action === "add" && input.addedStudents.length > 0) {
      const addedStudents = input.addedStudents
      const csvKey = githubKeys.csvFile(org, CONFIG_REPO, rosterPath(classroom))
      queryClient.setQueryData<StudentCsvRow[]>(csvKey, (current) => {
        const list = current ?? []
        const seen = new Set(
          list.flatMap((s) => [
            s.github_id?.trim(),
            s.username?.trim().toLowerCase(),
          ]),
        )
        const toAppend = addedStudents.filter(
          (s) =>
            !(s.github_id && seen.has(s.github_id.trim())) &&
            !(s.username && seen.has(s.username.trim().toLowerCase())),
        )
        return toAppend.length > 0 ? [...list, ...toAppend] : list
      })
      // Seed the team cache too, so the member reads as "enrolled" immediately.
      // buildTeamRoster/aggregate read id+login.
      queryClient.setQueryData<GitHubUser[]>(
        githubKeys.teamMembers(org, teamSlugFor(classroom)),
        (current) => {
          const list = current ?? []
          const have = new Set(list.map((m) => String(m.id)))
          const stubs = addedStudents
            .filter((s) => s.github_id && !have.has(s.github_id.trim()))
            .map(
              (s) =>
                ({
                  id: Number(s.github_id),
                  login: s.username,
                  avatar_url: "",
                  html_url: "",
                  name: null,
                  email: null,
                  bio: null,
                  permissions: {
                    admin: false,
                    pull: true,
                    maintain: false,
                    push: false,
                  },
                }) satisfies GitHubUser,
            )
          return stubs.length > 0 ? [...list, ...stubs] : list
        },
      )
    }

    if (input.action === "remove" && affectedKeys.length > 0) {
      const removedRows = rows.filter((r) => affectedKeys.includes(r.key))
      optimisticRemove(classroom, removedRows)
    }

    // Recompute members against the seeded caches, leaving them alone;
    // reconcile both on a delay.
    queryClient.invalidateQueries({ queryKey: githubKeys.orgMembersAll(org) })
    invalidateInviteQueries(queryClient, org)
    invalidateClassroom(classroom, { skipCsv: true })
    setSelectedKeys(new Set())
    scheduleClassroomReconcile(classroom)
  }

  // Inline row invite for an on-roster non-member (mirrors the detail-drawer
  // action). Invites by github_id so a stale username doesn't matter.
  const handleQuickInvite = async (row: OrgMemberRow) => {
    if (!org || invitingKey) return
    setInvitingKey(row.key)
    try {
      await runInviteMember(client, org, row, notify, () => refreshInvite(), t)
    } finally {
      setInvitingKey(null)
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = rows.filter((row) => {
      if (
        q &&
        ![row.username, row.name, row.email].some((field) =>
          field.toLowerCase().includes(q),
        )
      ) {
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
    })
    if (!tableSort) return base
    const [column, direction] = tableSort.split("-") as [
      OrgMembersSortColumn,
      "asc" | "desc",
    ]
    return sortOrgMemberRowsBy(base, column, direction)
  }, [rows, query, classroomFilter, tableSort])

  // Active-filter split for the in-search-bar clear affordance ("Clear filter"
  // vs "Clear"), mirroring the roster controls; clicking it resets query and
  // the classroom filter (sort is a view preference, not a filter — kept).
  const hasFilterActive = classroomFilter !== ""
  const hasActiveFilter = hasFilterActive || query.trim() !== ""
  const clearAllFilters = () => {
    setQuery("")
    setClassroomFilter("")
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

  const isSelf = (row: OrgMemberRow) =>
    isSameGitHubUser(viewer ?? null, {
      github_id: row.github_id,
      username: row.username,
    })

  // An org owner/admin: in the fetched admin-id set, or the signed-in account
  // (always an owner here — page is owner-gated — even if the admin list
  // couldn't be read).
  const isOwner = (row: OrgMemberRow) =>
    (Boolean(row.github_id) && ownerIds.has(row.github_id)) || isSelf(row)

  // The signed-in owner can't be bulk-added/removed — a row is selectable only
  // when it isn't self.
  const isSelectable = (row: OrgMemberRow) => !isSelf(row)

  // Rows backing the current selection, across the full set (a selected row
  // hidden by search is still acted on), self always excluded.
  const selectedRows = useMemo(
    () => resolveSelectedRows(rows, selectedKeys, isSelectable),
    // isSelf/isSelectable depend on viewer; recompute when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, selectedKeys, viewer],
  )

  // Shift-click range selection over the rendered order. OrgMembersPage renders
  // `filtered` flat (no grouping), so the filtered list IS the rendered order.
  const { handleToggleRow, handleRowCheckboxClick } = useRangeSelection(
    filtered,
    isSelectable,
    setSelectedKeys,
  )

  // Select-all targets the currently-filtered SELECTABLE rows (self excluded),
  // without disturbing selected rows outside the current filter.
  const selectableFiltered = useMemo(
    () => selectableRows(filtered, isSelectable),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, viewer],
  )
  const {
    allSelected: allFilteredSelected,
    someSelected: someFilteredSelected,
  } = selectAllState(selectableFiltered, selectedKeys)
  const handleToggleSelectAll = () =>
    setSelectedKeys((prev) => toggleSelectAll(selectableFiltered, prev))

  const classroomOptions = useMemo(
    () => classes.map((c) => ({ name: c.name, path: c.path })),
    [classes],
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

          <AnimatedAlert
            tone="warning"
            show={notes.length > 0}
            className="mt-6 text-sm"
            role="status"
          >
            <span>{notes.join(" ")}</span>
          </AnimatedAlert>

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

          {/* One toolbar row (mirroring the roster/submissions controls): the
              member-count caption — swapped for the selection cluster while
              rows are selected — on the left; search + the classroom filter
              right-aligned. */}
          <Toolbar className="mt-6">
            {selectedKeys.size === 0 && !isLoading && !isError ? (
              <span className="text-sm text-base-content/60 tabular-nums">
                {t("orgMembers.bulk.memberCount", { count: filtered.length })}
              </span>
            ) : null}
            {org ? (
              <BulkActionsBar
                org={org}
                client={client}
                selectedRows={selectedRows}
                members={members}
                classrooms={classroomOptions}
                onClearSelection={() => setSelectedKeys(new Set())}
                onDone={handleBulkDone}
              />
            ) : null}
            <Toolbar.Trailing>
              <Toolbar.Search
                placeholder={t("orgMembers.searchPlaceholder")}
                ariaLabel={t("orgMembers.searchLabel")}
                value={query}
                onChange={setQuery}
                onClear={clearAllFilters}
                clearActive={hasActiveFilter}
                hasFilterActive={hasFilterActive}
              />
              <Toolbar.FilterSelect
                icon={<FilterIcon aria-hidden="true" className="size-4" />}
                active={classroomFilter !== ""}
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

          {/* Primer DataTable treatment (matching the roster/assignments
              tables): the shared TableShell frame, labeled columns, and rows
              as real <tr>s. Select-all lives in the select-column header,
              aligned above the row checkboxes; the selection actions sit in
              the toolbar above. */}
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
                    label={t("orgMembers.table.colMember")}
                    sort={tableSort ?? undefined}
                    asc="member-asc"
                    desc="member-desc"
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
                  block and replays on data arrival / classroom-filter changes
                  (not per search keystroke). */}
              <motion.tbody
                key={`${isLoading}:${classroomFilter}`}
                variants={blockEnter}
                initial="initial"
                animate="animate"
              >
                {isLoading && <SkeletonRows rows={6} bars={SKELETON_BARS} />}
                {!isLoading && isError && (
                  <tr>
                    <td
                      colSpan={MEMBERS_COL_COUNT}
                      className="py-10 text-center text-sm text-error"
                    >
                      {t("orgMembers.loadError")}
                    </td>
                  </tr>
                )}
                {!isLoading && !isError && filtered.length === 0 && (
                  <tr>
                    <td colSpan={MEMBERS_COL_COUNT}>
                      <EmptyState
                        variant="bare"
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
                    </td>
                  </tr>
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
                        <input
                          type="checkbox"
                          className="checkbox checkbox-sm size-6"
                          aria-label={
                            isSelf(row)
                              ? t("orgMembers.bulk.selfNotSelectable")
                              : t("orgMembers.bulk.selectRow", {
                                  label: row.username || row.email || row.name,
                                })
                          }
                          disabled={isSelf(row)}
                          title={
                            isSelf(row)
                              ? t("orgMembers.bulk.selfNotSelectable")
                              : undefined
                          }
                          checked={selectedKeys.has(row.key)}
                          onClick={(e) => {
                            e.stopPropagation()
                            handleRowCheckboxClick(e, row.key)
                          }}
                          onChange={() => handleToggleRow(row.key)}
                        />
                      </td>
                      <td className="min-w-0">
                        <Avatar
                          name={row.name || row.username || row.email}
                          github={row.username}
                          initials={initialsFor(row)}
                          subtitle={<GitHubIdentity row={row} />}
                          onClick={() => setSelectedKey(row.key)}
                        />
                      </td>
                      <td className="hidden whitespace-nowrap text-xs text-base-content/70 sm:table-cell">
                        {t("orgMembers.classroomCount", {
                          count: row.classrooms.length,
                        })}
                      </td>
                      <td>
                        <div className="flex flex-wrap items-center gap-2">
                          {row.unprovisionedClassrooms.length > 0 ? (
                            <Badge
                              tone="warning"
                              className="gap-1"
                              title={t("orgMembers.unprovisionedTitle", {
                                classrooms:
                                  row.unprovisionedClassrooms.join(", "),
                              })}
                            >
                              <AlertIcon
                                aria-hidden="true"
                                className="size-3"
                              />
                              {t("orgMembers.unprovisionedBadge")}
                            </Badge>
                          ) : null}
                          <ClassificationBadge
                            row={row}
                            isOwner={isOwner(row)}
                          />
                        </div>
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
          onRemoved={() => {
            const affected = selected
            setSelectedKey(null)
            if (affected) refresh(affected)
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
