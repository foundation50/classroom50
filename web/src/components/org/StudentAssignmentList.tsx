import { Link } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  CalendarClock,
  CircleAlert,
  FilePlus2,
  UserRound,
  UsersRound,
} from "lucide-react"

import { Alert, Badge, Button, Card, Toolbar } from "@/components/ui"
import { EmptyState, NoSearchResults, ViewToggle } from "@/components/list"
import { EnterDiv } from "@/lib/motionComponents"
import { useGithubAuth } from "@/auth/useGithubAuth"
import usePagesAssignments from "@/hooks/usePagesAssignments"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import { useStudentClassrooms } from "@/hooks/useStudentClassrooms"
import { useListPrefsState } from "@/lib/listPrefs"
import { studentAssignmentListPrefs } from "@/lib/studentAssignmentListPrefs"
import {
  DEFAULT_STUDENT_FILTERS,
  filterAndSortStudentAssignments,
  type StudentAssignmentFilters,
  type StudentAssignmentSort,
} from "@/components/org/studentAssignmentFilters"
import { studentRepoName } from "@/util/studentRepo"
import {
  dueDeadlineInstant,
  formatDueDateTime,
  formatRelativeToNow,
  isPastDue,
} from "@/util/formatDate"
import type { Assignment } from "@/types/classroom"

// Resolve the classroom's capability secret for a student, config-free: the
// team-description bootstrap record (useStudentClassrooms) is the primary
// source; for a pre-schema team it falls back to any of the student's accepted
// repos' membership in this classroom (the caller passes that secret in). Empty
// when the classroom is listed (no secret needed).
function useClassroomSecret(
  org: string,
  classroom: string,
): string | undefined {
  const { classrooms } = useStudentClassrooms(org)
  return classrooms.find((c) => c.classroom === classroom)?.secret
}

function ModeBadge({ mode }: { mode: Assignment["mode"] }) {
  const { t } = useTranslation()
  if (mode === "group") {
    return (
      <Badge ghost className="gap-1">
        <UsersRound aria-hidden="true" className="size-3.5" />
        {t("assignments.discover.modeGroup")}
      </Badge>
    )
  }
  return (
    <Badge ghost className="gap-1">
      <UserRound aria-hidden="true" className="size-3.5" />
      {t("assignments.discover.modeIndividual")}
    </Badge>
  )
}

function DueBadge({ due }: { due?: string }) {
  const { t } = useTranslation()
  const overdue = due ? isPastDue(due) : false
  // Relative countdown ("in 3 days" / "2 hours ago") next to the absolute date,
  // reusing the same helper the teacher submissions dashboard uses so the two
  // agree on bare-date deadline semantics (end-of-local-day).
  const relative = due
    ? formatRelativeToNow(dueDeadlineInstant(due) ?? new Date(due))
    : null
  return (
    <Badge
      tone={overdue ? "error" : "neutral"}
      ghost={!overdue}
      className="gap-1"
    >
      <CalendarClock aria-hidden="true" className="size-3.5" />
      {due ? (
        <>
          {t("assignments.discover.due", { date: formatDueDateTime(due) })}
          {relative ? ` (${relative})` : ""}
        </>
      ) : (
        t("assignments.discover.noDue")
      )}
    </Badge>
  )
}

// The accept/view-submission CTA, shared by the grid card and the list row.
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
      <Link
        type="button"
        to="/$org/$classroom/assignments/$assignment/submission"
        params={{ org, classroom, assignment: assignment.slug }}
        className="btn btn-outline btn-primary btn-sm"
      >
        {t("assignments.discover.viewSubmission")}
      </Link>
    )
  }
  return (
    <Link
      type="button"
      to="/$org/$classroom/assignments/$assignment/accept"
      params={{ org, classroom, assignment: assignment.slug }}
      search={secret ? { k: secret } : undefined}
      className="btn btn-primary btn-sm"
    >
      <FilePlus2 aria-hidden="true" className="size-4" />
      {t("assignments.discover.accept")}
    </Link>
  )
}

// Shown only for a not-yet-accepted assignment (accepted ones need no badge —
// the "View my submission" CTA already conveys that state). Red to nudge action.
function NotAcceptedBadge() {
  const { t } = useTranslation()
  return (
    <Badge tone="error" className="shrink-0 gap-1">
      <CircleAlert aria-hidden="true" className="size-3.5" />
      {t("assignments.discover.notAccepted")}
    </Badge>
  )
}

type AssignmentItemProps = {
  org: string
  classroom: string
  assignment: Assignment
  accepted: boolean
  secret?: string
}

// Grid layout: a two-per-row card.
function AssignmentCard({
  org,
  classroom,
  assignment,
  accepted,
  secret,
}: AssignmentItemProps) {
  return (
    <Card
      as={EnterDiv}
      radius="xl"
      bordered={false}
      shadow={false}
      className="col-span-12 border border-base-200 md:col-span-6"
    >
      <Card.Body className="gap-3">
        <h3 className="min-w-0 truncate text-base font-semibold">
          {assignment.name || assignment.slug}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {!accepted && <NotAcceptedBadge />}
          <ModeBadge mode={assignment.mode} />
          <DueBadge due={assignment.due} />
        </div>
        <Card.Actions className="pt-1">
          <AssignmentCta
            org={org}
            classroom={classroom}
            assignment={assignment}
            accepted={accepted}
            secret={secret}
          />
        </Card.Actions>
      </Card.Body>
    </Card>
  )
}

// List layout: a full-width row, title + badges on the left, CTA on the right.
function AssignmentListItem({
  org,
  classroom,
  assignment,
  accepted,
  secret,
}: AssignmentItemProps) {
  return (
    <EnterDiv className="col-span-12 flex flex-col gap-3 rounded-xl border border-base-200 bg-base-100 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1.5">
        <h3 className="min-w-0 truncate text-base font-semibold">
          {assignment.name || assignment.slug}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {!accepted && <NotAcceptedBadge />}
          <ModeBadge mode={assignment.mode} />
          <DueBadge due={assignment.due} />
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end">
        <AssignmentCta
          org={org}
          classroom={classroom}
          assignment={assignment}
          accepted={accepted}
          secret={secret}
        />
      </div>
    </EnterDiv>
  )
}

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
  viewMode,
  onViewChange,
}: {
  query: string
  onQueryChange: (value: string) => void
  filters: StudentAssignmentFilters
  onFiltersChange: (filters: StudentAssignmentFilters) => void
  sort: StudentAssignmentSort
  onSortChange: (sort: StudentAssignmentSort) => void
  viewMode: "grid" | "list"
  onViewChange: (mode: "grid" | "list") => void
}) {
  const { t } = useTranslation()
  const hasActiveFilter =
    query.trim() !== "" ||
    filters.status !== "all" ||
    filters.type !== "all" ||
    filters.due !== "all"

  return (
    <Toolbar>
      <Toolbar.Search
        placeholder={t("assignments.discover.toolbar.searchPlaceholder")}
        value={query}
        onChange={onQueryChange}
        ariaLabel={t("assignments.discover.toolbar.searchAria")}
      />

      <Toolbar.FilterSelect
        label={t("assignments.discover.toolbar.statusLabel")}
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
        label={t("assignments.discover.toolbar.typeLabel")}
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
        label={t("assignments.discover.toolbar.dueLabel")}
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

      {hasActiveFilter && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onQueryChange("")
            onFiltersChange({ ...DEFAULT_STUDENT_FILTERS })
          }}
        >
          {t("assignments.discover.toolbar.clear")}
        </Button>
      )}

      <Toolbar.Trailing>
        <Toolbar.FilterSelect
          label={t("assignments.discover.toolbar.sortLabel")}
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

        <ViewToggle
          viewMode={viewMode}
          onChange={onViewChange}
          groupLabel={t("assignments.discover.toolbar.view.label")}
          gridLabel={t("assignments.discover.toolbar.view.gridLabel")}
          listLabel={t("assignments.discover.toolbar.view.listLabel")}
        />
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
  const secret = useClassroomSecret(org, classroom)
  const { viewMode, sortKey, changeView, changeSort } = useListPrefsState(
    studentAssignmentListPrefs,
  )
  const [query, setQuery] = useState("")
  const [filters, setFilters] = useState<StudentAssignmentFilters>({
    ...DEFAULT_STUDENT_FILTERS,
  })

  const {
    data: assignments,
    isLoading,
    isError,
  } = usePagesAssignments(org, classroom, secret)
  const { data: repos } = useGetOrgRepos(org)

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
      if (writableNames.has(studentRepoName(classroom, a.slug, login))) {
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

  if (isLoading) {
    return (
      <div className="grid grid-cols-12 gap-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <div
            key={i}
            className="skeleton skeleton-shimmer col-span-12 h-36 rounded-xl md:col-span-6"
          />
        ))}
      </div>
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

  return (
    <div className="space-y-4">
      <StudentAssignmentsToolbar
        query={query}
        onQueryChange={setQuery}
        filters={filters}
        onFiltersChange={setFilters}
        sort={sortKey}
        onSortChange={changeSort}
        viewMode={viewMode}
        onViewChange={changeView}
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
        <div className="grid grid-cols-12 gap-4">
          {visible.map((assignment) =>
            viewMode === "grid" ? (
              <AssignmentCard
                key={assignment.slug}
                org={org}
                classroom={classroom}
                assignment={assignment}
                accepted={acceptedSlugs.has(assignment.slug)}
                secret={secret}
              />
            ) : (
              <AssignmentListItem
                key={assignment.slug}
                org={org}
                classroom={classroom}
                assignment={assignment}
                accepted={acceptedSlugs.has(assignment.slug)}
                secret={secret}
              />
            ),
          )}
        </div>
      )}
    </div>
  )
}

export default StudentAssignmentList
