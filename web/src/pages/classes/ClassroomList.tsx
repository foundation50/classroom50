import { Link } from "@tanstack/react-router"
import { LayoutGrid, List as ListIcon, Plus, Search } from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import useClassroomSummaries, {
  type ClassroomSummary,
} from "@/hooks/useClassroomSummaries"
import type { GitHubFileListing } from "@/hooks/github/types"
import {
  getStoredSortKey,
  getStoredViewMode,
  persistSortKey,
  persistViewMode,
  type ClassroomSortKey,
  type ClassroomViewMode,
} from "@/lib/classroomListPrefs"
import { ClassroomCard, ClassroomRow } from "@/pages/classes/ClassroomCard"

type ClassFilter = "active" | "archived" | "all"

const SORT_OPTIONS: { key: ClassroomSortKey; labelKey: string }[] = [
  { key: "name-asc", labelKey: "classes.toolbar.sort.nameAsc" },
  { key: "term", labelKey: "classes.toolbar.sort.term" },
  { key: "student-count", labelKey: "classes.toolbar.sort.studentCount" },
]

const displayName = (s: ClassroomSummary) =>
  s.name || s.short_name || s.path || ""

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
  const [viewMode, setViewMode] = useState<ClassroomViewMode>(getStoredViewMode)
  const [sortKey, setSortKey] = useState<ClassroomSortKey>(getStoredSortKey)
  const [filter, setFilter] = useState<ClassFilter>("active")
  const [search, setSearch] = useState("")
  // While any card's menu is open, freeze the rendered order so an async
  // re-sort (e.g. a roster resolving under student-count sort) can't shift a
  // different classroom under the open menu and mis-target a destructive click.
  const [menuOpen, setMenuOpen] = useState(false)

  const changeView = (mode: ClassroomViewMode) => {
    setViewMode(mode)
    persistViewMode(mode)
  }
  const changeSort = (key: ClassroomSortKey) => {
    setSortKey(key)
    persistSortKey(key)
  }

  const summaries = useClassroomSummaries(
    org,
    dirs,
    sortKey === "student-count",
  )

  const query = search.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      summaries.filter((s) => {
        if (s.loading) return false
        if (filter === "active" && s.archived) return false
        if (filter === "archived" && !s.archived) return false
        if (!query) return true
        return (
          displayName(s).toLowerCase().includes(query) ||
          s.path.toLowerCase().includes(query) ||
          (s.term ?? "").toLowerCase().includes(query)
        )
      }),
    [summaries, filter, query],
  )

  const sorted = useMemo(() => {
    const byName = (a: ClassroomSummary, b: ClassroomSummary) =>
      displayName(a).localeCompare(displayName(b))
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

  // Snapshot the order while a menu is open (see menuOpen above).
  const [frozen, setFrozen] = useState<ClassroomSummary[] | null>(null)
  const displayList = menuOpen && frozen ? frozen : sorted
  const handleMenuOpenChange = (open: boolean) => {
    setFrozen(open ? sorted : null)
    setMenuOpen(open)
  }

  const anyResolved = summaries.some((s) => !s.loading)
  const noResults = anyResolved && query.length > 0 && sorted.length === 0
  const emptyFilter = anyResolved && query.length === 0 && sorted.length === 0

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="input input-bordered flex w-full items-center gap-2 sm:max-w-xs">
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

        <div className="flex flex-wrap items-center gap-3">
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

          <select
            className="select select-bordered select-sm"
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

          <div
            role="group"
            aria-label={t("classes.toolbar.view.label")}
            className="join"
          >
            <button
              type="button"
              className={`btn btn-sm join-item ${viewMode === "grid" ? "btn-active" : ""}`}
              aria-label={t("classes.toolbar.view.gridLabel")}
              aria-pressed={viewMode === "grid"}
              onClick={() => changeView("grid")}
            >
              <LayoutGrid aria-hidden="true" className="size-4" />
            </button>
            <button
              type="button"
              className={`btn btn-sm join-item ${viewMode === "list" ? "btn-active" : ""}`}
              aria-label={t("classes.toolbar.view.listLabel")}
              aria-pressed={viewMode === "list"}
              onClick={() => changeView("list")}
            >
              <ListIcon aria-hidden="true" className="size-4" />
            </button>
          </div>

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
      </div>

      {noResults ? (
        <div className="rounded-2xl border border-dashed border-base-300 bg-base-100 p-8 text-center">
          <h2 className="text-lg font-semibold">
            {t("classes.noResults.title")}
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-base-content/70">
            {t("classes.noResults.body", { query: search.trim() })}
          </p>
          <button
            type="button"
            className="btn btn-ghost btn-sm mt-4"
            onClick={() => setSearch("")}
          >
            {t("classes.noResults.clear")}
          </button>
        </div>
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
