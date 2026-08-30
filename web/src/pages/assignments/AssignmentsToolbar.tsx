import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { ArrowSwitchIcon, FilterIcon } from "@/components/ui/icons"

import { Toolbar } from "@/components/ui"
import {
  DEFAULT_FILTERS,
  type AssignmentFilters,
  type AssignmentSort,
} from "@/pages/assignments/assignmentList"

// Search + type/due filters + sort for the teacher assignments table.
// Controlled by TeacherAssignmentsView; emits query/filter/sort changes.
// Mirrors the submissions toolbar layout: `leading` hosts the left-aligned
// classroom-wide action (Collect all), while search + filters + sort + the
// trailing actions (the New assignment split button or the archived badge)
// sit on the right — so the primary action lives in the bar, not the page
// header. The bar renders only once assignments exist: on a first-use empty
// list the table's blankslate owns the New-assignment action instead.
const AssignmentsToolbar = ({
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  leading,
  trailing,
}: {
  query: string
  onQueryChange: (value: string) => void
  filters: AssignmentFilters
  onFiltersChange: (filters: AssignmentFilters) => void
  sort: AssignmentSort
  onSortChange: (sort: AssignmentSort) => void
  // Left-aligned lead content (the Collect all button), as on the submissions
  // toolbar where DataFreshness leads. Search + filters + sort + actions sit
  // on the right.
  leading?: ReactNode
  trailing?: ReactNode
}) => {
  const { t } = useTranslation()
  const hasFilterActive = filters.type !== "all" || filters.due !== "all"
  const hasActiveFilter = hasFilterActive || query.trim() !== ""

  const clearAll = () => {
    onQueryChange("")
    onFiltersChange({ ...DEFAULT_FILTERS })
  }

  return (
    <Toolbar>
      {leading}

      <Toolbar.Trailing>
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
          icon={<FilterIcon aria-hidden="true" className="size-4" />}
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
          icon={<FilterIcon aria-hidden="true" className="size-4" />}
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

        <Toolbar.FilterSelect
          icon={
            <ArrowSwitchIcon aria-hidden="true" className="size-4 rotate-90" />
          }
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
