import { Link, useNavigate } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"
import {
  AlertIcon,
  ArrowSwitchIcon,
  FileAddedIcon,
  FilterIcon,
} from "@/components/ui/icons"

import {
  Alert,
  Badge,
  RouterButton,
  SkeletonRows,
  SortableTh,
  TableShell,
  Toolbar,
} from "@/components/ui"
import {
  DueDateCell,
  ModeBadge,
} from "@/components/assignments/AssignmentCells"
import { EmptyState, NoSearchResults } from "@/components/list"
import { ClickableTr } from "@/lib/motionComponents"
import { blockEnter } from "@/lib/motion"
import { isInteractiveEventTarget } from "@/util/interactiveTarget"
import { useGithubAuth } from "@/auth/useGithubAuth"
import usePagesAssignments from "@/hooks/usePagesAssignments"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import { useClassroomSecret } from "@/hooks/useStudentClassrooms"
import { useListPrefsState } from "@/lib/listPrefs"
import { studentAssignmentListPrefs } from "@/lib/studentAssignmentListPrefs"
import {
  DEFAULT_STUDENT_FILTERS,
  filterAndSortStudentAssignments,
  isListableToStudent,
  type StudentAssignmentFilters,
  type StudentAssignmentSort,
} from "@/components/org/studentAssignmentFilters"
import { studentRepoName, parseGroupRepoCounter } from "@/util/studentRepo"
import type { Assignment } from "@/types/classroom"

// The accept/view-submission CTA, the row's primary action.
function AssignmentCta({
  org,
  classroom,
  assignment,
  accepted,
  secret,
}: {
  org: string
  classroom: string
  assignment: Assignment
  accepted: boolean
  secret?: string
}) {
  const { t } = useTranslation()
  if (accepted) {
    return (
      <RouterButton
        to="/$org/$classroom/assignments/$assignment/submission"
        params={{ org, classroom, assignment: assignment.slug }}
        variant="outline"
        size="sm"
      >
        {t("assignments.discover.viewSubmission")}
      </RouterButton>
    )
  }
  return (
    <RouterButton
      to="/$org/$classroom/assignments/$assignment/accept"
      params={{ org, classroom, assignment: assignment.slug }}
      search={secret ? { k: secret } : undefined}
      variant="primary"
      size="sm"
    >
      <FileAddedIcon aria-hidden="true" className="size-4" />
      {t("assignments.discover.accept")}
    </RouterButton>
  )
}

type AssignmentItemProps = {
  org: string
  classroom: string
  assignment: Assignment
  accepted: boolean
  secret?: string
}

// One assignment row, teacher-table style: name + slug, shared type/due
// cells, an explicit status badge, and the CTA. The whole row is a click
// target for the CTA's destination (mouse convenience — the name link and CTA
// keep it keyboard-reachable), with the guard yielding to inner controls.
function AssignmentRow({
  org,
  classroom,
  assignment,
  accepted,
  secret,
}: AssignmentItemProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // The row's ONE destination (view-submission once accepted, else accept
  // with the capability secret), shared by the row click, the name link, and
  // the CTA so the three can't drift.
  const destination = accepted
    ? ({
        to: "/$org/$classroom/assignments/$assignment/submission",
        params: { org, classroom, assignment: assignment.slug },
      } as const)
    : ({
        to: "/$org/$classroom/assignments/$assignment/accept",
        params: { org, classroom, assignment: assignment.slug },
        search: secret ? { k: secret } : undefined,
      } as const)
  return (
    <ClickableTr
      className="hover:bg-base-200"
      onClick={(event) => {
        if (isInteractiveEventTarget(event)) return
        void navigate(destination)
      }}
    >
      <td className="truncate">
        <Link
          {...destination}
          className="font-bold link link-info no-underline"
          onClick={(event) => event.stopPropagation()}
        >
          {assignment.name || assignment.slug}
        </Link>
        <div className="font-mono text-xs text-base-content/70">
          {assignment.slug}
        </div>
      </td>
      <td className="max-xl:text-xs">
        <ModeBadge mode={assignment.mode} />
      </td>
      <td>
        <DueDateCell due={assignment.due} relative />
      </td>
      <td>
        {accepted ? (
          <Badge tone="success" className="whitespace-nowrap">
            {t("assignments.discover.accepted")}
          </Badge>
        ) : (
          <Badge tone="error" className="shrink-0 gap-1 whitespace-nowrap">
            <AlertIcon aria-hidden="true" className="size-4" />
            {t("assignments.discover.notAccepted")}
          </Badge>
        )}
      </td>
      {/* Quarantined from the row click so a near-miss around the CTA never
          double-navigates. */}
      <td onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-end">
          <AssignmentCta
            org={org}
            classroom={classroom}
            assignment={assignment}
            accepted={accepted}
            secret={secret}
          />
        </div>
      </td>
    </ClickableTr>
  )
}

// The column headers, shared by the loaded table and the loading skeleton.
// Assignment and Due date sort via the shared header control, in sync with
// the toolbar's sort select.
function TableHead({
  sort,
  onSortChange,
}: {
  sort: StudentAssignmentSort
  onSortChange: (sort: StudentAssignmentSort) => void
}) {
  const { t } = useTranslation()
  return (
    <thead>
      <tr>
        <SortableTh
          label={t("assignments.table.colAssignment")}
          sort={sort}
          asc="name-asc"
          desc="name-desc"
          onSortChange={onSortChange}
          title={t("assignments.table.sortByName")}
        />
        <th scope="col">{t("assignments.table.colType")}</th>
        <SortableTh
          label={t("assignments.table.colDueDate")}
          sort={sort}
          asc="due-asc"
          desc="due-desc"
          onSortChange={onSortChange}
          title={t("assignments.table.sortByDue")}
        />
        <th scope="col">{t("assignments.discover.colStatus")}</th>
        <th scope="col">
          <span className="sr-only">{t("assignments.discover.colAction")}</span>
        </th>
      </tr>
    </thead>
  )
}

const SKELETON_BARS = [
  "h-4 w-40",
  "h-4 w-20",
  "h-4 w-28",
  "h-4 w-24",
  "ms-auto h-8 w-28",
]

// Student-relevant toolbar: search, plus status (to-do vs accepted — the axis a
// student cares about most), type, and an overdue filter, with a due-first sort.
// Deliberately omits teacher-only facets (there's no roster/publish/edit here).
function StudentAssignmentsToolbar({
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
}: {
  query: string
  onQueryChange: (value: string) => void
  filters: StudentAssignmentFilters
  onFiltersChange: (filters: StudentAssignmentFilters) => void
  sort: StudentAssignmentSort
  onSortChange: (sort: StudentAssignmentSort) => void
}) {
  const { t } = useTranslation()
  const hasFilterActive =
    filters.status !== "all" || filters.type !== "all" || filters.due !== "all"
  const hasActiveFilter = hasFilterActive || query.trim() !== ""

  const clearAll = () => {
    onQueryChange("")
    onFiltersChange({ ...DEFAULT_STUDENT_FILTERS })
  }

  return (
    <Toolbar>
      <Toolbar.Search
        placeholder={t("assignments.discover.toolbar.searchPlaceholder")}
        value={query}
        onChange={onQueryChange}
        ariaLabel={t("assignments.discover.toolbar.searchAria")}
        onClear={clearAll}
        clearActive={hasActiveFilter}
        hasFilterActive={hasFilterActive}
      />

      <Toolbar.FilterSelect
        icon={<FilterIcon aria-hidden="true" className="size-4" />}
        active={filters.status !== "all"}
        value={filters.status}
        onChange={(e) =>
          onFiltersChange({
            ...filters,
            status: e.target.value as StudentAssignmentFilters["status"],
          })
        }
        aria-label={t("assignments.discover.toolbar.statusAria")}
      >
        <option value="all">
          {t("assignments.discover.toolbar.statusAll")}
        </option>
        <option value="todo">
          {t("assignments.discover.toolbar.statusTodo")}
        </option>
        <option value="accepted">
          {t("assignments.discover.toolbar.statusAccepted")}
        </option>
      </Toolbar.FilterSelect>

      <Toolbar.FilterSelect
        icon={<FilterIcon aria-hidden="true" className="size-4" />}
        active={filters.type !== "all"}
        value={filters.type}
        onChange={(e) =>
          onFiltersChange({
            ...filters,
            type: e.target.value as StudentAssignmentFilters["type"],
          })
        }
        aria-label={t("assignments.discover.toolbar.typeAria")}
      >
        <option value="all">{t("assignments.discover.toolbar.typeAll")}</option>
        <option value="individual">
          {t("assignments.discover.toolbar.typeIndividual")}
        </option>
        <option value="group">
          {t("assignments.discover.toolbar.typeGroup")}
        </option>
      </Toolbar.FilterSelect>

      <Toolbar.FilterSelect
        icon={<FilterIcon aria-hidden="true" className="size-4" />}
        active={filters.due !== "all"}
        value={filters.due}
        onChange={(e) =>
          onFiltersChange({
            ...filters,
            due: e.target.value as StudentAssignmentFilters["due"],
          })
        }
        aria-label={t("assignments.discover.toolbar.dueAria")}
      >
        <option value="all">{t("assignments.discover.toolbar.dueAll")}</option>
        <option value="overdue">
          {t("assignments.discover.toolbar.dueOverdue")}
        </option>
      </Toolbar.FilterSelect>

      <Toolbar.Trailing>
        <Toolbar.FilterSelect
          icon={
            <ArrowSwitchIcon aria-hidden="true" className="size-4 rotate-90" />
          }
          value={sort}
          onChange={(e) =>
            onSortChange(e.target.value as StudentAssignmentSort)
          }
          aria-label={t("assignments.discover.toolbar.sortAria")}
        >
          <option value="due-asc">
            {t("assignments.discover.toolbar.sortDueAsc")}
          </option>
          <option value="due-desc">
            {t("assignments.discover.toolbar.sortDueDesc")}
          </option>
          <option value="name-asc">
            {t("assignments.discover.toolbar.sortNameAsc")}
          </option>
          <option value="name-desc">
            {t("assignments.discover.toolbar.sortNameDesc")}
          </option>
        </Toolbar.FilterSelect>
      </Toolbar.Trailing>
    </Toolbar>
  )
}

// The student's per-classroom assignment discovery list: every published
// assignment (not just accepted ones), each with the right CTA. The secret
// (team description, config-free) unlocks a protected classroom's Pages data
// even before the student accepts. A protected classroom whose secret is still
// unknown shows the invite-link fallback rather than a misleading empty list.
export function StudentAssignmentList({
  org,
  classroom,
}: {
  org: string
  classroom: string
}) {
  const { t } = useTranslation()
  const { user } = useGithubAuth()
  const {
    secret,
    pagesBaseUrl,
    isLoading: loadingSecret,
  } = useClassroomSecret(org, classroom)
  const { sortKey, changeSort } = useListPrefsState(studentAssignmentListPrefs)
  const [query, setQuery] = useState("")
  const [filters, setFilters] = useState<StudentAssignmentFilters>({
    ...DEFAULT_STUDENT_FILTERS,
  })

  const {
    data: assignments,
    isLoading: loadingAssignmentsData,
    isError,
  } = usePagesAssignments(org, classroom, secret, {
    enabled: !loadingSecret,
    pagesBaseUrl,
  })
  // Acceptance (the CTA and the red badge) is derived from the org repo list;
  // fold its load into the gate so a row never paints "Accept" and then
  // flips to "View my submission" once the repos land.
  const { data: repos, isLoading: loadingRepos } = useGetOrgRepos(org)
  const isLoading = loadingSecret || loadingAssignmentsData || loadingRepos

  const acceptedSlugs = useMemo(() => {
    const set = new Set<string>()
    const login = user?.login
    if (!login) return set
    // Set of the student's own writable repo names, then match each assignment's
    // canonical repo name against it (one pass each — no nested filter).
    const writableNames = new Set(
      (repos ?? [])
        .filter((repo) => repo.permissions?.push)
        .map((repo) => repo.name.toLowerCase()),
    )
    for (const a of assignments ?? []) {
      if (a.mode === "team") {
        // A team-mode repo is named after the group counter, not the login;
        // the viewer's push on any `<classroom>-<slug>-group-<n>` repo (via
        // the team attachment) means their group accepted. Mode-gated parse —
        // `group-3` is also a valid username shape.
        for (const name of writableNames) {
          if (parseGroupRepoCounter(name, classroom, a.slug) !== null) {
            set.add(a.slug)
            break
          }
        }
      } else if (writableNames.has(studentRepoName(classroom, a.slug, login))) {
        set.add(a.slug)
      }
    }
    return set
  }, [repos, assignments, classroom, user?.login])

  const visible = useMemo(
    () =>
      filterAndSortStudentAssignments(assignments ?? [], {
        query,
        filters,
        sort: sortKey,
        acceptedSlugs,
      }),
    [assignments, query, filters, sortKey, acceptedSlugs],
  )

  // Assignments listable to this student ignoring the search/status/type/due
  // facets: released or already accepted. Distinguishes "nothing available to
  // you yet" (all still link-only) from "your filters hid everything".
  const listableCount = useMemo(
    () =>
      (assignments ?? []).filter((a) =>
        isListableToStudent(a, acceptedSlugs.has(a.slug)),
      ).length,
    [assignments, acceptedSlugs],
  )

  if (isLoading) {
    return (
      // animate={false}: PageTransition already animates the page in.
      <TableShell animate={false} padded ariaBusy>
        <TableHead sort={sortKey} onSortChange={changeSort} />
        <tbody>
          <SkeletonRows rows={3} bars={SKELETON_BARS} />
        </tbody>
      </TableShell>
    )
  }

  // A protected classroom whose secret we can't resolve (pre-schema team, not
  // yet accepted) 404s the Pages read. Guide the student to the invite link
  // rather than implying the classroom has no assignments.
  if (isError) {
    return (
      <Alert tone="info">
        <div>{t("assignments.discover.protectedNoSecret")}</div>
      </Alert>
    )
  }

  if (!assignments || assignments.length === 0) {
    return (
      <EmptyState
        title={t("assignments.discover.emptyTitle")}
        body={t("assignments.discover.emptyBody")}
      />
    )
  }

  // Assignments exist but none are listable to this student yet (all still
  // link-only, none accepted). Point them at the invite link rather than
  // showing a filter-oriented "no results" that clearing filters won't fix.
  if (listableCount === 0) {
    return (
      <EmptyState
        title={t("assignments.discover.linkOnlyTitle")}
        body={t("assignments.discover.linkOnlyBody")}
      />
    )
  }

  return (
    <div className="space-y-3">
      <StudentAssignmentsToolbar
        query={query}
        onQueryChange={setQuery}
        filters={filters}
        onFiltersChange={setFilters}
        sort={sortKey}
        onSortChange={changeSort}
      />

      {visible.length === 0 ? (
        <NoSearchResults
          title={t("assignments.discover.noResults.title")}
          body={t("assignments.discover.noResults.body")}
          clearLabel={t("assignments.discover.toolbar.clear")}
          onClear={() => {
            setQuery("")
            setFilters({ ...DEFAULT_STUDENT_FILTERS })
          }}
        />
      ) : (
        // Same table shell as the teacher assignments list, so the two
        // surfaces read as one design. Its entrance is off — the tbody
        // blockEnter below is the data-arrival cue.
        <TableShell animate={false} padded>
          <caption className="sr-only">
            {t("assignments.discover.tableCaption")}
          </caption>
          <TableHead sort={sortKey} onSortChange={changeSort} />
          {/* Same recipe as the teacher table: the body enters as one block
              (blockEnter) and replays when the view changes (filter/sort — not
              per search keystroke, which would remount the rows mid-typing). */}
          <motion.tbody
            key={`${JSON.stringify(filters)}|${sortKey}`}
            variants={blockEnter}
            initial="initial"
            animate="animate"
          >
            {visible.map((assignment) => (
              <AssignmentRow
                key={assignment.slug}
                org={org}
                classroom={classroom}
                assignment={assignment}
                accepted={acceptedSlugs.has(assignment.slug)}
                secret={secret}
              />
            ))}
          </motion.tbody>
        </TableShell>
      )}
    </div>
  )
}

export default StudentAssignmentList
