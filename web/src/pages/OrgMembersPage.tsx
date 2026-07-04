import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useParams } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle,
  ChevronRight,
  ExternalLink,
  Search,
  UserPlus,
} from "lucide-react"

import Drawer, {
  DrawerContent,
  DrawerSidebar,
  DrawerToggle,
} from "@/components/drawer"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import RequireTeacher from "@/components/RequireTeacher"
import Avatar from "@/components/avatar"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useGitHubViewer } from "@/hooks/github/hooks"
import { githubKeys, invalidateInviteQueries } from "@/hooks/github/queries"
import useOrgMembersOverview from "@/hooks/useOrgMembersOverview"
import type { OrgMemberRow } from "@/util/orgMembers"
import type { StudentCsvRow } from "@/api/mutations/students"
import { isSameGitHubUser } from "@/util/students"
import { motion } from "motion/react"
import { enterExit } from "@/lib/motion"
import { ClickableRow } from "@/lib/motionComponents"
import BulkActionsBar from "@/pages/orgMembers/BulkActionsBar"
import MemberDetailModal from "@/pages/orgMembers/MemberDetailModal"
import {
  resolveSelectedRows,
  selectableRows,
  selectAllState,
  toggleRow,
  toggleSelectAll,
} from "@/pages/orgMembers/selection"
import {
  ClassificationBadge,
  GitHubIdentity,
  initialsFor,
  runInviteMember,
} from "@/pages/orgMembers/memberPresentation"
import useGetClasses from "@/hooks/useGetClasses"

// How long to wait before reconciling an optimistically-updated students.csv
// cache with the authoritative GitHub read. GitHub's contents API lags a fresh
// commit by a beat, so an immediate refetch would read the pre-commit file and
// revert the optimistic change; this delay lets it catch up.
const CSV_RECONCILE_DELAY_MS = 4000

// Sentinel classroom-filter value for "members on no classroom roster". A real
// classroom path can't collide with it (paths don't contain a leading colon).
const NO_CLASSROOM_FILTER = ":none:"

const OrgMembersPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.members"))
  const { org } = useParams({ strict: false })
  const client = useGitHubClient()
  const { notify } = useToast()
  const queryClient = useQueryClient()
  const { data: viewer } = useGitHubViewer()
  const { rows, members, ownerIds, isLoading, isError, notes } =
    useOrgMembersOverview(org)
  const { classes } = useGetClasses(org)
  const [query, setQuery] = useState("")
  // Classroom filter: "" = all, NO_CLASSROOM_FILTER = members on no roster,
  // else a classroom path. Applied on top of the text search.
  const [classroomFilter, setClassroomFilter] = useState("")
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [invitingKey, setInvitingKey] = useState<string | null>(null)
  // Multi-select for bulk classroom actions. Selection is by row key and
  // persists across search filtering (a hidden-but-selected row is still acted
  // on); "select all" targets the currently-filtered rows.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())

  const refresh = (affected?: OrgMemberRow) => {
    if (!org) return
    queryClient.invalidateQueries({ queryKey: githubKeys.orgMembersAll(org) })
    invalidateInviteQueries(queryClient, org)
    // removeMemberFromOrg rewrites each affected classroom's students.csv, which
    // the aggregation reads via csvFileQuery; invalidate those (and the
    // classroom.json) so the page doesn't show a just-removed student as still
    // enrolled until the 5-minute staleTime elapses.
    for (const access of affected?.classrooms ?? []) {
      invalidateClassroom(access.classroom)
    }
  }

  // Invalidate the caches a roster write touches for one classroom. `skipCsv`
  // omits the students.csv query — used right after we've OPTIMISTICALLY seeded
  // that cache, because invalidating it forces an immediate refetch that reads
  // the still-pre-commit CSV back from GitHub (its contents API lags a commit)
  // and clobbers the seed, reverting the row status. Shared by the single-row
  // and bulk paths.
  const invalidateClassroom = (
    classroom: string,
    opts?: { skipCsv?: boolean },
  ) => {
    if (!org) return
    if (!opts?.skipCsv) {
      queryClient.invalidateQueries({
        queryKey: githubKeys.csvFile(
          org,
          "classroom50",
          `${classroom}/students.csv`,
        ),
      })
    }
    queryClient.invalidateQueries({
      queryKey: githubKeys.jsonFile(
        org,
        "classroom50",
        `${classroom}/classroom.json`,
      ),
    })
    queryClient.invalidateQueries({
      queryKey: githubKeys.teamMembers(org, `classroom50-${classroom}`),
    })
  }

  // After a bulk add/remove: optimistically reflect the change in the caches
  // the row status derives from, then reconcile with the (eventually-consistent)
  // server on a short delay.
  //
  // The row's classification + classroom list come from aggregateOrgMembers over
  // the per-classroom students.csv reads (csvFileQuery). GitHub's contents API
  // lags a commit, so invalidating that CSV now would refetch the PRE-commit
  // file and revert the change. So we mutate the target classroom's csv cache in
  // place (append on add, drop on remove), invalidate everything EXCEPT that CSV,
  // and schedule a delayed CSV invalidation to let the authoritative read catch
  // up. classroomOptions keys on `path` — the same key useOrgMembersOverview
  // reads the CSV under — so the seed lands on the cache the page actually uses.
  const handleBulkDone = (input: {
    classroom: string
    action: "add" | "remove"
    addedStudents: StudentCsvRow[]
    affectedKeys: string[]
  }) => {
    if (!org) return
    const { classroom, action, addedStudents, affectedKeys } = input
    const csvKey = githubKeys.csvFile(
      org,
      "classroom50",
      `${classroom}/students.csv`,
    )

    if (action === "add" && addedStudents.length > 0) {
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
    }

    if (action === "remove" && affectedKeys.length > 0) {
      // Drop the removed members from the target classroom's csv cache. Match on
      // the same github_id/username identity the removed rows carry.
      const removedRows = rows.filter((r) => affectedKeys.includes(r.key))
      const removedIds = new Set(
        removedRows.map((r) => r.github_id?.trim()).filter(Boolean),
      )
      const removedLogins = new Set(
        removedRows.map((r) => r.username?.trim().toLowerCase()).filter(Boolean),
      )
      queryClient.setQueryData<StudentCsvRow[]>(csvKey, (current) => {
        if (!current) return current
        return current.filter(
          (s) =>
            !(s.github_id && removedIds.has(s.github_id.trim())) &&
            !(s.username && removedLogins.has(s.username.trim().toLowerCase())),
        )
      })
    }

    // Recompute the members list against the (now-seeded) roster caches, but
    // leave the seeded CSV alone — invalidating it would refetch the pre-commit
    // file and revert the optimistic change.
    queryClient.invalidateQueries({ queryKey: githubKeys.orgMembersAll(org) })
    invalidateInviteQueries(queryClient, org)
    invalidateClassroom(classroom, { skipCsv: true })
    setSelectedKeys(new Set())

    // Reconcile the CSV with the authoritative server state once GitHub's
    // contents API has caught up with the commit.
    window.setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: csvKey })
    }, CSV_RECONCILE_DELAY_MS)
  }

  // Inline row invite for an on-roster non-member (mirrors the detail-drawer
  // action). Invites by github_id so a stale username doesn't matter.
  const handleQuickInvite = async (row: OrgMemberRow) => {
    if (!org || invitingKey) return
    setInvitingKey(row.key)
    try {
      await runInviteMember(client, org, row, notify, () => refresh(row), t)
    } finally {
      setInvitingKey(null)
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((row) => {
      // Text search across username / name / email.
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
  }, [rows, query, classroomFilter])

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
  // (always an owner here — the page is owner-gated — even if the admin list
  // couldn't be read).
  const isOwner = (row: OrgMemberRow) =>
    (Boolean(row.github_id) && ownerIds.has(row.github_id)) || isSelf(row)

  // The signed-in account (an org owner, since this page is owner-gated) can't
  // be bulk-added/removed — a row is selectable only when it isn't self.
  const isSelectable = (row: OrgMemberRow) => !isSelf(row)

  // Rows backing the current selection, across the full set (a selected row
  // hidden by search is still acted on), with self always excluded so even a
  // stale selection can't target the signed-in owner.
  const selectedRows = useMemo(
    () => resolveSelectedRows(rows, selectedKeys, isSelectable),
    // isSelf/isSelectable depend on viewer; recompute when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, selectedKeys, viewer],
  )

  const handleToggleRow = (key: string) =>
    setSelectedKeys((prev) => toggleRow(prev, key))

  // Select-all targets the currently-filtered SELECTABLE rows (self excluded),
  // without disturbing any selected rows outside the current filter.
  const selectableFiltered = useMemo(
    () => selectableRows(filtered, isSelectable),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, viewer],
  )
  const { allSelected: allFilteredSelected, someSelected: someFilteredSelected } =
    selectAllState(selectableFiltered, selectedKeys)
  const handleToggleSelectAll = () =>
    setSelectedKeys((prev) => toggleSelectAll(selectableFiltered, prev))

  const classroomOptions = useMemo(
    () => classes.map((c) => ({ name: c.name, path: c.path })),
    [classes],
  )

  return (
    <div className="min-h-screen">
      <Drawer>
        <DrawerToggle />
        <DrawerContent className="p-10 bg-base-200 xl:px-50">
          <RequireTeacher allow="owner">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                {t("orgMembers.heading")}
              </h1>
              <p className="mt-1 text-sm text-base-content/70">
                {t("orgMembers.subtitlePrefix")}{" "}
                <span className="font-mono font-semibold">{org}</span>{" "}
                {t("orgMembers.subtitleSuffix")}
              </p>
              <a
                href={`https://github.com/orgs/${org}/people`}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                <ExternalLink aria-hidden="true" className="size-3.5" />
                {t("orgMembers.manageMembersOnGitHub")}
              </a>
            </div>

            {notes.length > 0 ? (
              <div
                className="alert alert-warning alert-soft mt-6 text-sm"
                role="status"
              >
                <span>{notes.join(" ")}</span>
              </div>
            ) : null}

            {discrepancyCount > 0 ? (
              <div
                className="alert alert-error alert-soft mt-6 text-sm"
                role="status"
              >
                <AlertTriangle className="size-4" aria-hidden="true" />
                <span>
                  {t("orgMembers.discrepancy", { count: discrepancyCount })}
                </span>
              </div>
            ) : null}

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <label className="input input-bordered flex min-w-0 flex-1 items-center gap-2">
                <Search aria-hidden="true" className="size-4 opacity-50" />
                <input
                  type="search"
                  className="grow"
                  placeholder={t("orgMembers.searchPlaceholder")}
                  aria-label={t("orgMembers.searchLabel")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <select
                className="select select-bordered w-full sm:w-auto sm:min-w-[14rem]"
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
              </select>
            </div>

            <div className="mt-4 card card-border w-full overflow-hidden bg-base-100 shadow-sm">
              {isLoading ? (
                <div className="flex items-center justify-center gap-3 px-6 py-12 text-base-content/70">
                  <span
                    className="loading loading-spinner loading-md"
                    aria-hidden="true"
                  />
                  <span className="text-sm">{t("orgMembers.loading")}</span>
                </div>
              ) : isError ? (
                <div className="px-6 py-10 text-center text-sm text-error">
                  {t("orgMembers.loadError")}
                </div>
              ) : filtered.length === 0 ? (
                <div className="px-6 py-10 text-center text-sm text-base-content/70">
                  {classroomFilter === NO_CLASSROOM_FILTER
                    ? t("orgMembers.noMembersNoClassroom")
                    : classroomFilter
                      ? t("orgMembers.noMembersInClassroom", {
                          classroom:
                            classroomOptions.find(
                              (c) => c.path === classroomFilter,
                            )?.name ?? classroomFilter,
                        })
                      : t("orgMembers.noMatch")}
                </div>
              ) : (
                <>
                  {org ? (
                    <BulkActionsBar
                      org={org}
                      client={client}
                      selectedRows={selectedRows}
                      totalCount={filtered.length}
                      allSelected={allFilteredSelected}
                      someSelected={someFilteredSelected}
                      onToggleSelectAll={handleToggleSelectAll}
                      members={members}
                      classrooms={classroomOptions}
                      onClearSelection={() => setSelectedKeys(new Set())}
                      onDone={handleBulkDone}
                    />
                  ) : null}
                  <motion.ul
                    className="divide-y divide-base-300"
                    variants={enterExit}
                    initial="initial"
                    animate="animate"
                  >
                    {filtered.map((row) => (
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
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => handleToggleRow(row.key)}
                        />
                        <div className="min-w-0 flex-1">
                          <Avatar
                            name={row.name || row.username || row.email}
                            github={row.username}
                            initials={initialsFor(row)}
                            subtitle={<GitHubIdentity row={row} />}
                          />
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          {row.classification === "on-roster-not-member" &&
                          row.github_id ? (
                            <button
                              type="button"
                              className="btn btn-xs btn-primary"
                              disabled={invitingKey === row.key}
                              onClick={(e) => {
                                e.stopPropagation()
                                void handleQuickInvite(row)
                              }}
                            >
                              {invitingKey === row.key ? (
                                <span
                                  className="loading loading-spinner loading-xs"
                                  aria-hidden="true"
                                />
                              ) : (
                                <>
                                  <UserPlus
                                    aria-hidden="true"
                                    className="size-3.5"
                                  />
                                  {t("orgMembers.invite")}
                                </>
                              )}
                            </button>
                          ) : null}
                          <span className="hidden text-xs text-base-content/70 sm:inline">
                            {t("orgMembers.classroomCount", {
                              count: row.classrooms.length,
                            })}
                          </span>
                          {row.driftClassrooms.length > 0 ? (
                            <span
                              className="badge badge-sm badge-warning badge-soft gap-1"
                              title={t("orgMembers.driftTitle", {
                                classrooms: row.driftClassrooms.join(", "),
                              })}
                            >
                              <AlertTriangle
                                aria-hidden="true"
                                className="size-3"
                              />
                              {t("orgMembers.driftBadge")}
                            </span>
                          ) : null}
                          <ClassificationBadge row={row} isOwner={isOwner(row)} />
                          <ChevronRight
                            aria-hidden="true"
                            className="size-4 text-base-content/30 transition-transform duration-150 group-hover/row:translate-x-0.5 group-hover/row:text-base-content/70"
                          />
                        </div>
                      </ClickableRow>
                    ))}
                  </motion.ul>
                </>
              )}
            </div>
          </RequireTeacher>
        </DrawerContent>
        <DrawerSidebar page="classes" selected="members" />
      </Drawer>

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
        />
      ) : null}
    </div>
  )
}

export default OrgMembersPage
