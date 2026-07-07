import { Link } from "@tanstack/react-router"
import { Plus, Search } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { NoSearchResults, ViewToggle } from "@/components/list"
import useClassroomSummaries, {
  classroomDisplayName,
  type ClassroomSummary,
} from "@/hooks/useClassroomSummaries"
import type { GitHubFileListing } from "@/hooks/github/types"
import {
  classroomListPrefs,
  type ClassroomSortKey,
} from "@/lib/classroomListPrefs"
import { useListPrefsState } from "@/lib/listPrefs"
import { ClassroomCard, ClassroomRow } from "@/pages/classes/ClassroomCard"

type ClassFilter = "active" | "archived" | "all"

const SORT_OPTIONS: { key: ClassroomSortKey; labelKey: string }[] = [
  { key: "name-asc", labelKey: "classes.toolbar.sort.nameAsc" },
  { key: "term", labelKey: "classes.toolbar.sort.term" },
  { key: "student-count", labelKey: "classes.toolbar.sort.studentCount" },
]

// New classroom directories carry only name/path until classroom.json resolves;
// the summaries hook lifts term/active/counts so this list can filter, search,
// and sort before rendering the cards.
const ClassroomList = ({
  org,
  dirs,
}: {
  org: string
  dirs: GitHubFileListing[]
}) => {
  const { t } = useTranslation()
  const { viewMode, sortKey, changeView, changeSort } =
    useListPrefsState(classroomListPrefs)
  const [filter, setFilter] = useState<ClassFilter>("active")
  const [termFilter, setTermFilter] = useState<string>("all")
  const [search, setSearch] = useState("")

  const summaries = useClassroomSummaries(
    org,
    dirs,
    sortKey === "student-count",
  )

  // Distinct non-empty terms across the (resolved) classrooms, for the term
  // filter. Only offered when a teacher actually uses terms on 2+ of them.
  const terms = useMemo(() => {
    const set = new Set<string>()
    for (const s of summaries) {
      const term = s.term?.trim()
      if (term) set.add(term)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [summaries])
  const showTermFilter = terms.length > 1
  // Guard against a stale selection when the available terms change (e.g. the
  // last classroom of a term is deleted): fall back to "all".
  const activeTerm =
    termFilter !== "all" && !terms.includes(termFilter) ? "all" : termFilter

  const query = search.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      summaries.filter((s) => {
        if (s.loading) return false
        if (filter === "active" && s.archived) return false
        if (filter === "archived" && !s.archived) return false
        if (activeTerm !== "all" && (s.term?.trim() ?? "") !== activeTerm)
          return false
        if (!query) return true
        return (
          classroomDisplayName(s).toLowerCase().includes(query) ||
          s.path.toLowerCase().includes(query) ||
          (s.term ?? "").toLowerCase().includes(query)
        )
      }),
    [summaries, filter, activeTerm, query],
  )

  const sorted = useMemo(() => {
    const byName = (a: ClassroomSummary, b: ClassroomSummary) =>
      classroomDisplayName(a).localeCompare(classroomDisplayName(b))
    const list = [...filtered]
    switch (sortKey) {
      case "term":
        return list.sort(
          (a, b) => (a.term ?? "").localeCompare(b.term ?? "") || byName(a, b),
        )
      case "student-count":
        // Known counts high-to-low; unresolved/unknown pinned to the bottom in
        // stable name order so rows don't reshuffle as rosters resolve.
        return list.sort((a, b) => {
          const ca = a.studentCount
          const cb = b.studentCount
          if (ca !== undefined && cb !== undefined)
            return cb - ca || byName(a, b)
          if (ca !== undefined) return -1
          if (cb !== undefined) return 1
          return byName(a, b)
        })
      case "name-asc":
      default:
        return list.sort(byName)
    }
  }, [filtered, sortKey])

  // While a card is "busy" (its menu or a destructive confirm modal is open),
  // freeze the rendered order so an async re-sort (e.g. a roster resolving under
  // the student-count sort) can't reshuffle the list under an in-flight action.
  // A ref holds the latest sorted list so the callback can stay stable (a
  // changing callback identity would re-fire the child's effect every render).
  const [frozen, setFrozen] = useState<ClassroomSummary[] | null>(null)
  const sortedRef = useRef(sorted)
  useEffect(() => {
    sortedRef.current = sorted
  }, [sorted])
  const displayList = frozen ?? sorted
  const handleMenuOpenChange = useCallback((busy: boolean) => {
    setFrozen(busy ? sortedRef.current : null)
  }, [])

  const anyResolved = summaries.some((s) => !s.loading)
  const noResults = anyResolved && query.length > 0 && sorted.length === 0
  const emptyFilter = anyResolved && query.length === 0 && sorted.length === 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-base-300 bg-base-100 p-2">
        <label className="input input-sm input-bordered flex min-w-48 flex-1 items-center gap-2">
          <Search aria-hidden="true" className="size-4 text-base-content/50" />
          <input
            type="search"
            className="grow"
            placeholder={t("classes.toolbar.searchPlaceholder")}
            aria-label={t("classes.toolbar.searchLabel")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>

        <div
          role="group"
          aria-label={t("classes.filter.label")}
          className="join"
        >
          {(["active", "archived", "all"] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={`btn btn-sm join-item ${filter === f ? "btn-active" : ""}`}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {t(`classes.filter.${f}`)}
            </button>
          ))}
        </div>

        {showTermFilter && (
          <div className="join">
            <span className="join-item flex items-center border border-base-300 bg-base-200 px-3 text-sm text-base-content/70">
              {t("classes.toolbar.termPrefix")}
            </span>
            <select
              className="select select-bordered select-sm join-item"
              aria-label={t("classes.toolbar.termLabel")}
              value={activeTerm}
              onChange={(e) => setTermFilter(e.target.value)}
            >
              <option value="all">{t("classes.toolbar.allTerms")}</option>
              {terms.map((term) => (
                <option key={term} value={term}>
                  {term}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="join">
          <span className="join-item flex items-center border border-base-300 bg-base-200 px-3 text-sm text-base-content/70">
            {t("classes.toolbar.sortPrefix")}
          </span>
          <select
            className="select select-bordered select-sm join-item"
            aria-label={t("classes.toolbar.sort.label")}
            value={sortKey}
            onChange={(e) => changeSort(e.target.value as ClassroomSortKey)}
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {t(opt.labelKey)}
              </option>
            ))}
          </select>
        </div>

        <ViewToggle
          viewMode={viewMode}
          onChange={changeView}
          groupLabel={t("classes.toolbar.view.label")}
          gridLabel={t("classes.toolbar.view.gridLabel")}
          listLabel={t("classes.toolbar.view.listLabel")}
        />

        <div className="mx-1 hidden h-6 w-px self-center bg-base-300 sm:block" />

        <Link
          to="/$org/classes/new"
          params={{ org }}
          type="button"
          className="btn btn-primary btn-sm"
        >
          <Plus aria-hidden="true" className="size-4" />
          {t("classes.newClass")}
        </Link>
      </div>

      {noResults ? (
        <NoSearchResults
          title={t("classes.noResults.title")}
          body={t("classes.noResults.body", { query: search.trim() })}
          clearLabel={t("classes.noResults.clear")}
          onClear={() => setSearch("")}
        />
      ) : emptyFilter ? (
        <div className="rounded-2xl border border-dashed border-base-300 bg-base-100 p-8 text-center">
          <p className="text-sm text-base-content/70">
            {t(`classes.emptyFilter.${filter}`)}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-4">
          {displayList.map((summary) =>
            viewMode === "grid" ? (
              <ClassroomCard
                key={summary.path}
                summary={summary}
                org={org}
                canManage
                onMenuOpenChange={handleMenuOpenChange}
              />
            ) : (
              <ClassroomRow
                key={summary.path}
                summary={summary}
                org={org}
                canManage
                onMenuOpenChange={handleMenuOpenChange}
              />
            ),
          )}
        </div>
      )}
    </div>
  )
}

export default ClassroomList
