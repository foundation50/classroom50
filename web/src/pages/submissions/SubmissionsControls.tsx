import { Search, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button, Select } from "@/components/ui"
import type {
  SubmissionFilters,
  SubmissionSort,
} from "@/pages/submissions/dashboard"
import { DEFAULT_FILTERS } from "@/pages/submissions/dashboard"

// Search + sort + filter controls for the assignment overview dashboard.
// Controlled by SubmissionsPage; emits filter/sort/query changes. The
// not-submitted filter is hidden for group assignments; passing/accepted selects
// appear only when available.
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

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <label className="input input-bordered input-sm flex min-w-[12rem] flex-1 items-center gap-2 sm:max-w-xs">
        <Search aria-hidden="true" className="size-4 opacity-60" />
        <input
          type="search"
          className="grow"
          placeholder={
            isGroup
              ? t("submissions.filters.searchGroupPlaceholder")
              : t("submissions.filters.searchStudentPlaceholder")
          }
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          aria-label={t("submissions.filters.searchAria")}
        />
      </label>

      {sections.length > 0 && (
        <Select
          selectSize="sm"
          className="w-auto min-w-0 max-w-[10rem]"
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
        </Select>
      )}

      <Select
        selectSize="sm"
        className="w-auto min-w-0"
        value={filters.submission}
        onChange={(e) =>
          onFiltersChange({
            ...filters,
            submission: e.target.value as SubmissionFilters["submission"],
          })
        }
        aria-label={t("submissions.filters.submissionAria")}
      >
        <option value="all">{t("submissions.filters.allSubmissions")}</option>
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
      </Select>

      {passingAvailable && (
        <Select
          selectSize="sm"
          className="w-auto min-w-0"
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
        </Select>
      )}

      {acceptedAvailable && (
        <Select
          selectSize="sm"
          className="w-auto min-w-0"
          value={filters.accepted}
          onChange={(e) =>
            onFiltersChange({
              ...filters,
              accepted: e.target.value as SubmissionFilters["accepted"],
            })
          }
          aria-label={t("submissions.filters.acceptedAria")}
        >
          <option value="all">{t("submissions.filters.allAcceptance")}</option>
          <option value="accepted">{t("submissions.filters.accepted")}</option>
          <option value="not-accepted">
            {t("submissions.filters.notAccepted")}
          </option>
        </Select>
      )}

      {hasActiveFilter && (
        <Button variant="ghost" size="sm" onClick={clearAll}>
          <X aria-hidden="true" className="size-4" />{" "}
          {t("submissions.filters.clear")}
        </Button>
      )}

      <Select
        selectSize="sm"
        className="ml-auto w-auto min-w-0"
        value={sort}
        onChange={(e) => onSortChange(e.target.value as SubmissionSort)}
        aria-label={t("submissions.filters.sortAria")}
      >
        <option value="recent">{t("submissions.filters.sortRecent")}</option>
        <option value="oldest">{t("submissions.filters.sortOldest")}</option>
        <option value="name-asc">{t("submissions.filters.sortNameAsc")}</option>
        <option value="name-desc">
          {t("submissions.filters.sortNameDesc")}
        </option>
      </Select>
    </div>
  )
}

export default SubmissionsControls
