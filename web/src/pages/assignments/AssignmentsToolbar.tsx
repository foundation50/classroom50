import { X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button, Toolbar } from "@/components/ui"
import {
  DEFAULT_FILTERS,
  type AssignmentFilters,
  type AssignmentSort,
} from "@/pages/assignments/assignmentList"

// Search + type/due filters + sort for the teacher assignments table.
// Controlled by TeacherAssignmentsView; emits query/filter/sort changes.
const AssignmentsToolbar = ({
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
}: {
  query: string
  onQueryChange: (value: string) => void
  filters: AssignmentFilters
  onFiltersChange: (filters: AssignmentFilters) => void
  sort: AssignmentSort
  onSortChange: (sort: AssignmentSort) => void
}) => {
  const { t } = useTranslation()
  const hasActiveFilter =
    query.trim() !== "" || filters.type !== "all" || filters.due !== "all"

  const clearAll = () => {
    onQueryChange("")
    onFiltersChange({ ...DEFAULT_FILTERS })
  }

  return (
    <Toolbar>
      <Toolbar.Search
        placeholder={t("assignments.toolbar.searchPlaceholder")}
        value={query}
        onChange={onQueryChange}
        ariaLabel={t("assignments.toolbar.searchAria")}
      />

      <Toolbar.FilterSelect
        label={t("assignments.toolbar.typeLabel")}
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
        label={t("assignments.toolbar.dueLabel")}
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

      {hasActiveFilter && (
        <Button variant="ghost" size="sm" onClick={clearAll}>
          <X aria-hidden="true" className="size-4" />{" "}
          {t("assignments.toolbar.clear")}
        </Button>
      )}

      <Toolbar.Trailing>
        <Toolbar.FilterSelect
          label={t("assignments.toolbar.sortLabel")}
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
      </Toolbar.Trailing>
    </Toolbar>
  )
}

export default AssignmentsToolbar
