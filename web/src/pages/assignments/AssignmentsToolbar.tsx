import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { ArrowUpDown, ListFilter } from "lucide-react"

import { Toolbar } from "@/components/ui"
import {
  DEFAULT_FILTERS,
  type AssignmentFilters,
  type AssignmentSort,
} from "@/pages/assignments/assignmentList"

// Search + type/due filters + sort for the teacher assignments table.
// Controlled by TeacherAssignmentsView; emits query/filter/sort changes.
// `trailing` hosts right-aligned actions (the New assignment split button or the
// archived badge), mirroring the submissions toolbar so the primary action sits
// in the bar, not the page header. When `actionsOnly` is set (no assignments
// exist yet) only the trailing actions render — the search/filter/sort controls
// would have nothing to act on.
const AssignmentsToolbar = ({
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  actionsOnly = false,
  trailing,
}: {
  query: string
  onQueryChange: (value: string) => void
  filters: AssignmentFilters
  onFiltersChange: (filters: AssignmentFilters) => void
  sort: AssignmentSort
  onSortChange: (sort: AssignmentSort) => void
  actionsOnly?: boolean
  trailing?: ReactNode
}) => {
  const { t } = useTranslation()
  const hasFilterActive = filters.type !== "all" || filters.due !== "all"
  const hasActiveFilter = hasFilterActive || query.trim() !== ""

  const clearAll = () => {
    onQueryChange("")
    onFiltersChange({ ...DEFAULT_FILTERS })
  }

  // With no assignments to filter, render only the trailing actions (e.g. New
  // assignment) so the primary action still lives in the bar.
  if (actionsOnly) {
    return trailing ? (
      <Toolbar>
        <Toolbar.Trailing>{trailing}</Toolbar.Trailing>
      </Toolbar>
    ) : null
  }

  return (
    <Toolbar>
      <Toolbar.Search
        placeholder={t("assignments.toolbar.searchPlaceholder")}
        value={query}
        onChange={onQueryChange}
        ariaLabel={t("assignments.toolbar.searchAria")}
        onClear={clearAll}
        clearActive={hasActiveFilter}
        hasFilterActive={hasFilterActive}
      />

      <Toolbar.FilterSelect
        icon={<ListFilter aria-hidden="true" className="size-4" />}
        active={filters.type !== "all"}
        value={filters.type}
        onChange={(e) =>
          onFiltersChange({
            ...filters,
            type: e.target.value as AssignmentFilters["type"],
          })
        }
        aria-label={t("assignments.toolbar.typeAria")}
      >
        <option value="all">{t("assignments.toolbar.typeAll")}</option>
        <option value="individual">
          {t("assignments.toolbar.typeIndividual")}
        </option>
        <option value="group">{t("assignments.toolbar.typeGroup")}</option>
      </Toolbar.FilterSelect>

      <Toolbar.FilterSelect
        icon={<ListFilter aria-hidden="true" className="size-4" />}
        active={filters.due !== "all"}
        value={filters.due}
        onChange={(e) =>
          onFiltersChange({
            ...filters,
            due: e.target.value as AssignmentFilters["due"],
          })
        }
        aria-label={t("assignments.toolbar.dueAria")}
      >
        <option value="all">{t("assignments.toolbar.dueAll")}</option>
        <option value="has-due">{t("assignments.toolbar.dueHas")}</option>
        <option value="no-due">{t("assignments.toolbar.dueNone")}</option>
        <option value="overdue">{t("assignments.toolbar.dueOverdue")}</option>
      </Toolbar.FilterSelect>

      <Toolbar.Trailing>
        <Toolbar.FilterSelect
          icon={<ArrowUpDown aria-hidden="true" className="size-4" />}
          value={sort}
          onChange={(e) => onSortChange(e.target.value as AssignmentSort)}
          aria-label={t("assignments.toolbar.sortAria")}
        >
          <option value="name-asc">
            {t("assignments.toolbar.sortNameAsc")}
          </option>
          <option value="name-desc">
            {t("assignments.toolbar.sortNameDesc")}
          </option>
          <option value="due-asc">{t("assignments.toolbar.sortDueAsc")}</option>
          <option value="due-desc">
            {t("assignments.toolbar.sortDueDesc")}
          </option>
          <option value="type">{t("assignments.toolbar.sortType")}</option>
        </Toolbar.FilterSelect>
        {trailing}
      </Toolbar.Trailing>
    </Toolbar>
  )
}

export default AssignmentsToolbar
