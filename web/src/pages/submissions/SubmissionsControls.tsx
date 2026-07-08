import { Search, X } from "lucide-react"
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"

import { Button, Input, LabeledControl, Select } from "@/components/ui"
import type {
  StatusSelectValue,
  SubmissionFilters,
  SubmissionSort,
} from "@/pages/submissions/dashboard"
import {
  DEFAULT_FILTERS,
  applyStatusSelection,
  statusSelectValue,
} from "@/pages/submissions/dashboard"

// A select glued to a labelled prefix (the org/classroom toolbar convention)
// via the shared LabeledControl primitive, so each dropdown reads as
// "Status: All" and its purpose is clear at a glance.
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

// Search + sort + filter controls for the assignment overview dashboard.
// Controlled by SubmissionsPage; emits filter/sort/query changes. The
// not-submitted filter is hidden for group assignments; passing/accepted selects
// appear only when available. `trailing` hosts the page's toolbar actions
// (updated/refresh, Metrics, Invite, Actions menu) so they share one bar with
// search + filters — keeping the roster high on the page.
const SubmissionsControls = ({
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  isGroup = false,
  acceptedAvailable = false,
  passingAvailable = false,
  sections = [],
  trailing,
}: {
  query: string
  onQueryChange: (value: string) => void
  filters: SubmissionFilters
  onFiltersChange: (filters: SubmissionFilters) => void
  sort: SubmissionSort
  onSortChange: (sort: SubmissionSort) => void
  isGroup?: boolean
  acceptedAvailable?: boolean
  passingAvailable?: boolean
  sections?: string[]
  trailing?: ReactNode
}) => {
  const { t } = useTranslation()
  const hasActiveFilter =
    filters.submission !== "all" ||
    filters.passing !== "all" ||
    filters.accepted !== "all" ||
    filters.section !== "all" ||
    query.trim() !== ""

  const clearAll = () => {
    onQueryChange("")
    onFiltersChange({ ...DEFAULT_FILTERS })
  }

  // The Status select folds the submission axis and the acceptance axis into one
  // control. Underneath they stay separate fields on SubmissionFilters (the
  // dashboard filter logic is unchanged); the select is just a combined view.
  // The value↔filters mapping lives in dashboard.ts (statusSelectValue /
  // applyStatusSelection) — typed option ids, unit-tested, no string parsing.
  const statusValue = statusSelectValue(filters)
  const onStatusChange = (value: StatusSelectValue) =>
    onFiltersChange(applyStatusSelection(filters, value))

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        type="search"
        inputSize="sm"
        className="min-w-[12rem] flex-1 sm:max-w-xs"
        leadingIcon={
          <Search aria-hidden="true" className="size-4 opacity-60" />
        }
        placeholder={
          isGroup
            ? t("submissions.filters.searchGroupPlaceholder")
            : t("submissions.filters.searchStudentPlaceholder")
        }
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        aria-label={t("submissions.filters.searchAria")}
      />

      {sections.length > 0 && (
        <LabeledSelect
          label={t("submissions.filters.sectionLabel")}
          className="max-w-[10rem]"
          value={filters.section}
          onChange={(e) =>
            onFiltersChange({ ...filters, section: e.target.value })
          }
          aria-label={t("submissions.filters.sectionAria")}
        >
          <option value="all">{t("submissions.filters.allSections")}</option>
          {sections.map((section) => (
            <option key={section} value={section}>
              {section}
            </option>
          ))}
        </LabeledSelect>
      )}

      <LabeledSelect
        label={t("submissions.filters.submissionLabel")}
        value={statusValue}
        onChange={(e) => onStatusChange(e.target.value as StatusSelectValue)}
        aria-label={t("submissions.filters.submissionAria")}
      >
        <option value="all">{t("submissions.filters.allStatuses")}</option>
        <option value="submitted">{t("submissions.filters.submitted")}</option>
        <option value="on-time">{t("submissions.filters.onTime")}</option>
        <option value="late">{t("submissions.filters.late")}</option>
        {!isGroup && (
          // A grade requires a submission, so "Not submitted" is mutually
          // exclusive with a passing/failing filter — disable it then.
          <option value="not-submitted" disabled={filters.passing !== "all"}>
            {t("submissions.filters.notSubmitted")}
          </option>
        )}
        {acceptedAvailable && (
          <>
            <option disabled>────────</option>
            <option value="accepted">
              {t("submissions.filters.accepted")}
            </option>
            <option value="not-accepted">
              {t("submissions.filters.notAccepted")}
            </option>
          </>
        )}
      </LabeledSelect>

      {passingAvailable && (
        <LabeledSelect
          label={t("submissions.filters.passingLabel")}
          value={filters.passing}
          // Disabled when filtering to non-submitters: they have no grade, so a
          // passing/failing filter would always yield an empty table.
          disabled={filters.submission === "not-submitted"}
          onChange={(e) =>
            onFiltersChange({
              ...filters,
              passing: e.target.value as SubmissionFilters["passing"],
            })
          }
          aria-label={t("submissions.filters.passingAria")}
        >
          <option value="all">{t("submissions.filters.allGrades")}</option>
          <option value="passing">{t("submissions.filters.passing")}</option>
          <option value="failing">{t("submissions.filters.failing")}</option>
        </LabeledSelect>
      )}

      {hasActiveFilter && (
        <Button variant="ghost" size="sm" onClick={clearAll}>
          <X aria-hidden="true" className="size-4" />{" "}
          {t("submissions.filters.clear")}
        </Button>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <LabeledSelect
          label={t("submissions.filters.sortLabel")}
          value={sort}
          onChange={(e) => onSortChange(e.target.value as SubmissionSort)}
          aria-label={t("submissions.filters.sortAria")}
        >
          <option value="recent">{t("submissions.filters.sortRecent")}</option>
          <option value="oldest">{t("submissions.filters.sortOldest")}</option>
          <option value="name-asc">
            {t("submissions.filters.sortNameAsc")}
          </option>
          <option value="name-desc">
            {t("submissions.filters.sortNameDesc")}
          </option>
        </LabeledSelect>
        {trailing}
      </div>
    </div>
  )
}

export default SubmissionsControls
