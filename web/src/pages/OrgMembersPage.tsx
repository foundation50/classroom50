import { useMemo, useRef, useState } from "react"
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
  Alert,
  AnimatedAlert,
  Button,
  Checkbox,
  SelectAllCheckbox,
  SelectSeparatorOption,
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
  filterOrgMemberRows,
  sortOrgMemberRowsBy,
  type OrgMemberRow,
  type OrgMembersRoleFilter,
  type OrgMembersSortColumn,
  type OrgMembersStatusFilter,
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
  GitHubIdentity,
  MemberStatusBadge,
  OrgRoleBadge,
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

// Trimmed-id + lowercased-login sets for matching rows against cached GitHub
// identities — the one matching recipe every optimistic cache drop uses.
const identitySets = (rows: OrgMemberRow[]) => ({
  ids: new Set(rows.map((r) => r.github_id?.trim()).filter(Boolean)),
  logins: new Set(
    rows.map((r) => r.username?.trim().toLowerCase()).filter(Boolean),
  ),
})

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
    refetchMembers,
    teamSlugByClassroom,
    displayNameByClassroom,
    notes,
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
  // Multi-select for bulk classroom actions. Selection is by row key and
  // persists across search filtering (a hidden-but-selected row is still acted
  // on); "select all" targets the currently-filtered rows.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  // True while a delayed members reconcile is scheduled — the window where an
  // eager orgMembersAll refetch would resurrect an optimistically-removed row.
  const membersReconcilePending = useRef(false)

  // After an org-level removal. The members-list read lags the membership
  // DELETE, so (like the CSV/team caches) drop the row optimistically and
  // reconcile on a delay; `removed` false = the DELETE failed, so only
  // re-read. `unenrolledClassrooms` is what the run REPORTED unenrolling —
  // never row.classrooms, which includes archived or failed unenrolls whose
  // rosters really do still hold the student.
  const refresh = (
    affected: OrgMemberRow,
    removed: boolean,
    unenrolledClassrooms: string[],
  ) => {
    if (!org) return
    if (removed) {
      optimisticRemoveFromMembers([affected])
      scheduleMembersReconcile()
      // Drop the stale selection key, or the vanished row keeps the toolbar
      // stuck at "N selected" with no visible checkbox to clear.
      setSelectedKeys((prev) => {
        if (!prev.has(affected.key)) return prev
        const next = new Set(prev)
        next.delete(affected.key)
        return next
      })
    } else {
      invalidateMembers()
    }
    invalidateInviteQueries(queryClient, org)
    for (const classroom of unenrolledClassrooms) {
      optimisticRemove(classroom, [affected])
      invalidateClassroom(classroom, { skipCsv: true })
      scheduleClassroomReconcile(classroom)
    }
  }

  // Refresh after an org invite (only org-invite state changed). Just re-read
  // the members + invite lists.
  const refreshInvite = () => {
    if (!org) return
    invalidateMembers()
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

  // Optimistically drop removed accounts from the orgMembersAll cache the row
  // list derives from. Invalidating instead would refetch a list that lags the
  // DELETE and resurrect the row (a roster-less member has no other cache to
  // disappear from at all).
  const optimisticRemoveFromMembers = (removed: OrgMemberRow[]) => {
    if (!org || removed.length === 0) return
    const { ids, logins } = identitySets(removed)
    queryClient.setQueryData<GitHubUser[]>(
      githubKeys.orgMembersAll(org),
      (current) =>
        current?.filter(
          (m) => !ids.has(String(m.id)) && !logins.has(m.login.toLowerCase()),
        ) ?? current,
    )
  }

  // Immediate members-list invalidation, deferred while a members reconcile
  // is pending — inside that window the lagging list would resurrect the
  // just-dropped row, and the reconcile refetches soon anyway.
  const invalidateMembers = () => {
    if (!org || membersReconcilePending.current) return
    queryClient.invalidateQueries({ queryKey: githubKeys.orgMembersAll(org) })
  }

  // Reconcile the members cache once the list API has caught up with the
  // DELETE (mirroring scheduleClassroomReconcile); defers invalidateMembers
  // while pending.
  const scheduleMembersReconcile = () => {
    if (!org) return
    membersReconcilePending.current = true
    window.setTimeout(() => {
      membersReconcilePending.current = false
      queryClient.invalidateQueries({ queryKey: githubKeys.orgMembersAll(org) })
    }, CSV_RECONCILE_DELAY_MS)
  }

  // Optimistically drop members (by resolved id/login) from BOTH the target
  // classroom's roster.csv AND its team-members cache, in the same tick, so
  // the two never disagree (which would flash a false "unprovisioned" state).
  // teamSlug is the resolved slug, so a collided-name classroom updates right.
  const optimisticRemove = (classroom: string, removed: OrgMemberRow[]) => {
    if (!org || removed.length === 0) return
    const { ids, logins } = identitySets(removed)
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
  // An org-wide removal fans the same treatment out to every classroom the
  // run actually unenrolled.
  const handleBulkDone = (input: BulkDoneInput) => {
    if (!org) return

    if (input.action === "remove-org") {
      const rowByKey = new Map(rows.map((r) => [r.key, r]))
      const removedRows = input.affectedKeys
        .map((key) => rowByKey.get(key))
        .filter((r): r is OrgMemberRow => Boolean(r))
      // Seed/reconcile the classrooms the run REPORTED unenrolling — a failed
      // org DELETE still changed its rosters. Deriving from row.classrooms
      // would assert unenrolls that were skipped (archived) or failed.
      const byClassroom = new Map<string, OrgMemberRow[]>()
      for (const { key, classrooms } of input.unenrolled) {
        const row = rowByKey.get(key)
        if (!row) continue
        for (const classroom of classrooms) {
          const list = byClassroom.get(classroom) ?? []
          list.push(row)
          byClassroom.set(classroom, list)
        }
      }
      for (const [classroom, unenrolledRows] of byClassroom) {
        optimisticRemove(classroom, unenrolledRows)
        invalidateClassroom(classroom, { skipCsv: true })
        scheduleClassroomReconcile(classroom)
      }
      // affectedKeys carry only CONFIRMED-removed rows, so the optimistic
      // members-cache drop (instead of a lag-prone refetch) is safe.
      optimisticRemoveFromMembers(removedRows)
      scheduleMembersReconcile()
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
    invalidateMembers()
    invalidateInviteQueries(queryClient, org)
    invalidateClassroom(classroom, { skipCsv: true })
    setSelectedKeys(new Set())
    scheduleClassroomReconcile(classroom)
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = filterOrgMemberRows(
      rows.filter((row) => {
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
                onClearSelection={() => setSelectedKeys(new Set())}
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
                  <tr>
                    <td
                      colSpan={MEMBERS_COL_COUNT}
                      className="px-6 py-10 text-center"
                    >
                      <span
                        role="alert"
                        className="inline-flex items-center gap-2 text-sm text-error"
                      >
                        <AlertIcon
                          aria-hidden="true"
                          className="size-4 shrink-0"
                        />
                        {t("orgMembers.loadError")}
                      </span>
                      <div className="mt-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={refetchMembers}
                        >
                          {t("orgMembers.retry")}
                        </Button>
                      </div>
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
                        <Checkbox
                          className="size-6"
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
