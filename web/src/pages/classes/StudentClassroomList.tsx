import { Link } from "@tanstack/react-router"
import { BookOpen, GraduationCap, Search } from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { EmptyState, NoSearchResults, ViewToggle } from "@/components/list"
import { Badge, Card, Input, LabeledControl, Select } from "@/components/ui"
import { EnterDiv } from "@/lib/motionComponents"
import { useListPrefsState } from "@/lib/listPrefs"
import {
  studentClassroomListPrefs,
  type StudentClassroomSortKey,
} from "@/lib/studentClassroomListPrefs"
import type { StudentClassroomSummary } from "@/hooks/useStudentClassroomSummaries"

const SORT_OPTIONS: { key: StudentClassroomSortKey; labelKey: string }[] = [
  { key: "name-asc", labelKey: "classes.student.toolbar.sort.nameAsc" },
  { key: "accepted-desc", labelKey: "classes.student.toolbar.sort.accepted" },
]

const classroomTitle = (c: StudentClassroomSummary) => c.name || c.classroom

function AcceptedStat({ count }: { count: number }) {
  const { t } = useTranslation()
  return (
    <span className="flex items-center gap-1.5 text-sm text-base-content/70">
      <BookOpen aria-hidden="true" className="size-4" />
      {count === 0
        ? t("classes.student.card.noneAccepted")
        : t("classes.student.card.acceptedCount", { count })}
    </span>
  )
}

function ViewAssignmentsLink({
  org,
  classroom,
  block,
}: {
  org: string
  classroom: string
  block?: boolean
}) {
  const { t } = useTranslation()
  return (
    <Link
      type="button"
      to="/$org/$classroom/assignments"
      params={{ org, classroom }}
      className={`btn btn-outline btn-primary btn-sm ${block ? "w-full" : ""}`}
    >
      {t("classes.viewAssignments")}
    </Link>
  )
}

function TermBadge({ term }: { term?: string }) {
  const { t } = useTranslation()
  return <Badge tone="primary">{term || t("classes.noTermSpecified")}</Badge>
}

function StudentClassroomCard({
  org,
  summary,
}: {
  org: string
  summary: StudentClassroomSummary
}) {
  return (
    <Card
      as={EnterDiv}
      radius="xl"
      shadow={false}
      className="col-span-12 md:col-span-6 xl:col-span-4"
    >
      <Card.Body className="gap-4">
        <TermBadge term={summary.term} />
        <h2 className="truncate text-xl font-semibold">
          {classroomTitle(summary)}
        </h2>
        <AcceptedStat count={summary.acceptedCount} />
        <ViewAssignmentsLink org={org} classroom={summary.classroom} block />
      </Card.Body>
    </Card>
  )
}

function StudentClassroomRow({
  org,
  summary,
}: {
  org: string
  summary: StudentClassroomSummary
}) {
  return (
    <EnterDiv className="col-span-12 flex flex-col gap-3 rounded-xl border border-base-300 bg-base-100 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-semibold">
            {classroomTitle(summary)}
          </span>
          <TermBadge term={summary.term} />
        </div>
        <AcceptedStat count={summary.acceptedCount} />
      </div>
      <div className="flex shrink-0 items-center justify-end">
        <ViewAssignmentsLink org={org} classroom={summary.classroom} />
      </div>
    </EnterDiv>
  )
}

function ClassroomsSkeleton() {
  return (
    <div className="grid grid-cols-12 gap-4">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="skeleton skeleton-shimmer col-span-12 h-40 rounded-xl md:col-span-6 xl:col-span-4"
        />
      ))}
    </div>
  )
}

// The student "My Classrooms" list: a search + sort + grid/list toolbar over the
// teams-derived summaries, mirroring the teacher ClassroomList shape but without
// the config-repo-only controls (term filter, archive filter, "New class").
export function StudentClassroomList({
  org,
  summaries,
  loading,
}: {
  org: string
  summaries: StudentClassroomSummary[]
  loading: boolean
}) {
  const { t } = useTranslation()
  const { viewMode, sortKey, changeView, changeSort } = useListPrefsState(
    studentClassroomListPrefs,
  )
  const [search, setSearch] = useState("")
  const query = search.trim().toLowerCase()

  const filtered = useMemo(() => {
    const list = summaries.filter((s) => {
      if (!query) return true
      return (
        classroomTitle(s).toLowerCase().includes(query) ||
        s.classroom.toLowerCase().includes(query) ||
        (s.term ?? "").toLowerCase().includes(query)
      )
    })
    const byName = (a: StudentClassroomSummary, b: StudentClassroomSummary) =>
      classroomTitle(a).localeCompare(classroomTitle(b))
    return [...list].sort((a, b) =>
      sortKey === "accepted-desc"
        ? b.acceptedCount - a.acceptedCount || byName(a, b)
        : byName(a, b),
    )
  }, [summaries, query, sortKey])

  if (loading) return <ClassroomsSkeleton />

  const noResults = query.length > 0 && filtered.length === 0
  const empty = query.length === 0 && summaries.length === 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-base-300 bg-base-100 p-2">
        <Input
          inputSize="sm"
          leadingIcon={
            <Search
              aria-hidden="true"
              className="size-4 text-base-content/50"
            />
          }
          className="min-w-48 flex-1"
          type="search"
          placeholder={t("classes.student.toolbar.searchPlaceholder")}
          aria-label={t("classes.student.toolbar.searchLabel")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <LabeledControl label={t("classes.toolbar.sortPrefix")}>
          <Select
            selectSize="sm"
            className="w-auto"
            aria-label={t("classes.toolbar.sort.label")}
            value={sortKey}
            onChange={(e) =>
              changeSort(e.target.value as StudentClassroomSortKey)
            }
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {t(opt.labelKey)}
              </option>
            ))}
          </Select>
        </LabeledControl>

        <ViewToggle
          viewMode={viewMode}
          onChange={changeView}
          groupLabel={t("classes.toolbar.view.label")}
          gridLabel={t("classes.toolbar.view.gridLabel")}
          listLabel={t("classes.toolbar.view.listLabel")}
        />
      </div>

      {noResults ? (
        <NoSearchResults
          title={t("classes.noResults.title")}
          body={t("classes.noResults.body", { query: search.trim() })}
          clearLabel={t("classes.noResults.clear")}
          onClear={() => setSearch("")}
        />
      ) : empty ? (
        <EmptyState
          icon={
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-base-200">
              <GraduationCap
                aria-hidden="true"
                className="size-6 text-base-content/70"
              />
            </div>
          }
          title={t("classes.student.emptyTitle")}
          body={t("classes.student.emptyBody")}
        />
      ) : (
        <div className="grid grid-cols-12 gap-4">
          {filtered.map((summary) =>
            viewMode === "grid" ? (
              <StudentClassroomCard
                key={summary.classroom}
                org={org}
                summary={summary}
              />
            ) : (
              <StudentClassroomRow
                key={summary.classroom}
                org={org}
                summary={summary}
              />
            ),
          )}
        </div>
      )}
    </div>
  )
}

export default StudentClassroomList
