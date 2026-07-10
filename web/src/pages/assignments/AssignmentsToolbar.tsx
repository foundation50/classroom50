import { Search, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button, Input, LabeledControl, Select } from "@/components/ui"
import {
  DEFAULT_FILTERS,
  type AssignmentFilters,
  type AssignmentSort,
} from "@/pages/assignments/assignmentList"

// A select glued to a labelled prefix (the org/classroom toolbar convention)
// via the shared LabeledControl primitive, so each dropdown reads as
// "Type: All" and its purpose is clear at a glance.
const LabeledSelect = ({
  label,
  className,
  children,
  ...props
}: {
  label: string
  className?: string
} & React.ComponentPropsWithoutRef<"select">) => (
  <LabeledControl label={label}>
    <Select
      selectSize="sm"
      className={`join-item w-auto min-w-0${className ? ` ${className}` : ""}`}
      {...props}
    >
      {children}
    </Select>
  </LabeledControl>
)

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
    <div className="flex flex-wrap items-center gap-2">
      <Input
        type="search"
        inputSize="sm"
        className="min-w-[12rem] flex-1 sm:max-w-xs"
        leadingIcon={
          <Search aria-hidden="true" className="size-4 opacity-60" />
        }
        placeholder={t("assignments.toolbar.searchPlaceholder")}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        aria-label={t("assignments.toolbar.searchAria")}
      />

      <LabeledSelect
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
      </LabeledSelect>

      <LabeledSelect
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
      </LabeledSelect>

      {hasActiveFilter && (
        <Button variant="ghost" size="sm" onClick={clearAll}>
          <X aria-hidden="true" className="size-4" />{" "}
          {t("assignments.toolbar.clear")}
        </Button>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <LabeledSelect
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
        </LabeledSelect>
      </div>
    </div>
  )
}

export default AssignmentsToolbar
